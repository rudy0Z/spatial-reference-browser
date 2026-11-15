'use strict';

// Pure link-branching policy for the Spatial shell (Phase 3, spec step 3).
//
// Every graph node is one browser tab (node-model.js). When a page opens a
// link the user asked for a branch of — Cmd/Ctrl+Click, middle-click,
// target="_blank" — the fresh main-process tab becomes a CHILD NODE with a
// parentUuid edge on the spatial graph. Some opens must never fork:
//   - form POSTs (a fresh tab would lose the body);
//   - OAuth/SSO/payment popups — those keep Blanc's setWindowOpenHandler
//     carve-outs (a real window whose opener survives) and collapse into ONE
//     `viaAuth` node per parent instead of a node per popup;
//   - redirect chains shorter than REDIRECT_COLLAPSE_MS — inside ONE tab the
//     hops are free (wireGraphNodeSync patches the node's url), and auth
//     popup chains that spawn several windows collapse into their ONE
//     viaAuth node instead of a node per hop.
//
// No Electron imports: unit-tested under node --test.

/** How long after a branch spawn a further hop counts as the same chain. */
const REDIRECT_COLLAPSE_MS = 3000;
/** How far from its parent a child node lands (x step; y alternates rows). */
const BRANCH_STEP_X = 384;
const BRANCH_STEP_Y = 64;
/** Filmstrip cap for did-navigate-in-page records. */
const MAX_SUB_PAGES = 32;

// OAuth/SSO/payment identity surfaces. Host matches are exact-host or
// dotted-suffix on the registrable domain; path matches are prefix matches
// on well-known authorization endpoints. Kept narrow on purpose: an over-
// broad list would swallow ordinary sign-in pages into non-branch nodes.
const AUTH_HOSTS = new Set([
  'accounts.google.com',
  'accounts.youtube.com',
  'github.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  'id.atlassian.com',
  'auth0.com',
  'stripe.com',
  'checkout.stripe.com',
  'pay.google.com',
  'paypal.com',
  'clerk.accounts.dev',
]);

const AUTH_HOST_SUFFIXES = ['.stripe.com', '.paypal.com', '.auth0.com', '.okta.com', '.okta-emea.com', '.clerk.accounts.dev', '.google.com', '.apple.com'];
const AUTH_PATHS = ['/login/oauth', '/oauth/', '/oauth2/', '/authorize', '/signin', '/sign-in', '/signin/', '/auth/', '/checkout', '/session/new'];

function hostMatchesAuth(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (AUTH_HOSTS.has(host)) return true;
  for (const suffix of AUTH_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) return true;
  }
  return false;
}

/** OAuth/SSO/payment popup URL. Deliberately conservative: a parsed URL with
 * one of the well-known auth/payment hosts, or an auth-shaped path on any
 * https host with a login/authorize segment. */
function looksLikeAuthOrPaymentUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  if (hostMatchesAuth(parsed.hostname)) return true;
  const path = parsed.pathname.toLowerCase();
  return AUTH_PATHS.some((segment) => path.startsWith(segment) || path.includes(segment));
}

/**
 * Which graph action a page-opened child takes.
 *   'fork'        — fresh main-process tab becomes a child node (the normal
 *                   Cmd/Ctrl+Click / middle-click / target=_blank branch).
 *   'via-auth'    — keep Blanc's real-window popup (opener must survive for
 *                   the flow), and record/collapse ONE viaAuth node.
 *   'refuse'      — a POST body or a non-navigable target: no node at all.
 *
 * `chromiumBuilt` — the WebContents Electron/Chromium built itself
 * (options.webContents present in the window-open handler). Only such
 * children may carry the opener's sandbox flags; a deferred creation is
 * Blanc's own fresh view and always safe (document-policy.js).
 */
function classifyChildBranch({ url, postBody = null, disposition = '', chromiumBuilt = false } = {}) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return 'refuse';
  // A POST resubmission can neither be forked (the body would be lost) nor
  // collapsed: refuse the branch and keep the popup path.
  if (postBody) return 'refuse';
  // OAuth/SSO/payment popups keep their real window (setWindowOpenHandler
  // carve-out) and collapse into a single viaAuth node per parent.
  if (looksLikeAuthOrPaymentUrl(url) || disposition === 'new-window') return 'via-auth';
  void chromiumBuilt;
  return 'fork';
}

/**
 * Whether a further spawn inside REDIRECT_COLLAPSE_MS belongs to the same
 * chain as `prev` and must patch that node instead of adding a sibling:
 * same parent branch, and the new URL continues the previous one (same
 * registrable origin, or the previous URL was itself auth/payment shaped —
 * providers hop across their own subdomains).
 */
function shouldCollapseBranch(prev, { url, at }, { chainMs = REDIRECT_COLLAPSE_MS } = {}) {
  if (!prev || typeof prev.url !== 'string' || typeof url !== 'string') return false;
  if (prev.viaAuth !== true) return false;
  const createdAt = Number.isFinite(prev.createdAt) ? prev.createdAt : 0;
  const now = Number.isFinite(at) ? at : Date.now();
  if (now - createdAt > chainMs) return false;
  try {
    const a = new URL(prev.url);
    const b = new URL(url);
    if (a.protocol !== b.protocol) return false;
    // Auth providers legitimately hop between their own hosts
    // (accounts.google.com → myaccount.google.com); collapse by suffix.
    const hostA = `.${a.hostname.replace(/\.$/, '')}`;
    const hostB = `.${b.hostname.replace(/\.$/, '')}`;
    if (a.hostname === b.hostname) return true;
    return hostA.endsWith(hostB) || hostB.endsWith(hostA);
  } catch {
    return false;
  }
}

/**
 * Deterministic child-node position: a horizontal chain stepping right of
 * the parent, alternating between two rows so siblings never stack exactly.
 * `siblingCount` is how many children the parent already has.
 */
function childBranchPosition(parent, siblingCount) {
  const px = Number.isFinite(parent?.x) ? parent.x : 0;
  const py = Number.isFinite(parent?.y) ? parent.y : 0;
  const index = Math.max(0, Math.min(15, Math.round(siblingCount ?? 0)));
  const row = index % 2 === 0 ? 1 : -1;
  return {
    x: Math.round(px + BRANCH_STEP_X * (index + 1)),
    y: Math.round(py + BRANCH_STEP_Y * row),
  };
}

/**
 * did-navigate-in-page filmstrip rule (spec: SPA in-domain navigation
 * records subPages[]). Records only same-document (pushState) commits,
 * dedupes consecutive repeats, and caps the strip — the oldest entries drop
 * first. Returns a NEW array; never mutates the input.
 */
function appendSubPage(subPages, url, at, { max = MAX_SUB_PAGES } = {}) {
  const list = Array.isArray(subPages) ? subPages : [];
  const last = list[list.length - 1];
  if (last && last.url === url) return list.slice();
  const next = [...list, { url: String(url ?? ''), at: Number.isFinite(at) ? at : 0 }];
  return next.length > max ? next.slice(next.length - max) : next;
}

module.exports = {
  REDIRECT_COLLAPSE_MS,
  BRANCH_STEP_X,
  BRANCH_STEP_Y,
  MAX_SUB_PAGES,
  looksLikeAuthOrPaymentUrl,
  classifyChildBranch,
  shouldCollapseBranch,
  childBranchPosition,
  appendSubPage,
};
