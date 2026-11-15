'use strict';

// §B.8.2 — the external-app scheme classifier (pure).
//
// A navigation to a native app's URL scheme must never become a node or a
// blank tab in the Spatial shell: the browser hands the URL to the OS behind
// a confirmation toast ("the system pays, the user confirms"). This module is
// the pure decision; the toast + shell.openExternal live in shell-bridge.js /
// shell-ipc.js, wired at tab-view.js's will-navigate and
// setWindowOpenHandler.
//
// Scope note: this classifier names the FAMILIAR app schemes the spec lists.
// Unknown custom schemes keep Blanc's generic external-protocol path
// (external-protocols.js classifyExternalNavigation — denylist + native
// consent dialog), so a hostile scheme can never ride the toast lane past
// that review.

const APP_SCHEMES = Object.freeze({
  'figma:': 'figma',
  'vscode:': 'vscode',
  'cursor:': 'cursor',
  'mailto:': 'mail',
  'discord:': 'discord',
  'spotify:': 'spotify',
  'slack:': 'slack',
});

// URL schemes can smuggle control characters into an openExternal argv
// (classic argument-injection shape). Anything with a C0/control byte, DEL,
// quote or backslash is not a navigable app link — refuse before the URL
// ever reaches a launcher.
const UNSAFE_CHARACTERS = /[\u0000-\u0020\u007f\\"`]/;

/**
 * Classify one navigation target for the Spatial handoff lane.
 * @param {string} url
 * @returns {{ action: 'handoff', scheme: string, app: string }
 *          | { action: 'none' }}
 *   'handoff' — consume the navigation and confirm through the shell toast.
 *   'none'    — not this module's lane: http(s)/internal/unknown schemes fall
 *               through to Blanc's own navigation policy untouched.
 */
function classifyExternalScheme(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > 4096) {
    return { action: 'none' };
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url) || UNSAFE_CHARACTERS.test(url)) {
    return { action: 'none' };
  }
  let protocol;
  try {
    protocol = new URL(url).protocol.toLowerCase();
  } catch {
    return { action: 'none' };
  }
  // Drive letters ("C:/x") parse as a 2-char protocol — never an app scheme.
  if (protocol.length === 2) return { action: 'none' };
  const app = APP_SCHEMES[protocol];
  if (!app) return { action: 'none' };
  return { action: 'handoff', scheme: protocol, app };
}

/** True when the URL must NEVER reach a WebContentsView as a document —
 *  consume the navigation entirely (no node, no blank pane) even before any
 *  confirmation. Only the classified app schemes get this treatment from this
 *  module; everything else is the caller's policy. */
const isAppSchemeUrl = (url) => classifyExternalScheme(url).action === 'handoff';

module.exports = { APP_SCHEMES, classifyExternalScheme, isAppSchemeUrl };
