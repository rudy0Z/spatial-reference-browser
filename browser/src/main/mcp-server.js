'use strict';

// LOCAL MCP SERVER BRIDGE (Phase 3.7, master-spec ADDENDUM + hardening notes).
//
// Exposes the Spatial Browser's spatial graph as a local Model Context
// Protocol server so external AI agents can READ the canvas and make
// "the system pays, the user confirms" WRITES — instead of bloating the UI
// with an in-browser chat sidebar.
//
//   main-process HTTP server  — 127.0.0.1 only, every call needs a bearer
//                               token generated at browser launch
//   stdio CLI wrapper         — `node mcp-server.js --stdio`: an MCP-stdio
//                               ⇄ HTTP bridge an MCP client can spawn
//
// THREAT MODEL (hardening notes, 2026-11-15, binding):
//   A 127.0.0.1 port is reachable by EVERY local process, so the HTTP
//   transport MUST reject unauthenticated calls. The per-launch token is
//   generated in main-process memory and handed ONLY to the stdio wrapper:
//   via the wrapper process env when the browser spawns it, and otherwise
//   via a per-launch handshake file (0600, userData/spatial-mcp/bridge.json)
//   that is deleted on quit. The token is never logged, never serialised
//   into a response, and never written anywhere world-readable.
//
// PRIVACY (binding): every response is built through an allowlist. Nodes
//   with `noCapture === true`, `viaAuth === true` or `private === true` are
//   excluded ENTIRELY — their urls, uuids, excerpts and thumbnails never
//   cross MCP, and edges/parents that point at them are cut. Cookies,
//   sessionStorage, credentials and ipc-trust tokens have no code path here:
//   the handlers only ever touch the node graph, the hibernation excerpt and
//   the shell-synced notes/regions.
//
// WRITES route through main-process command paths: branch_hibernated_nodes
//   applies the SAME model ops the UI's graph:mutate applies (add + parent
//   edge, persist, broadcast) and never spawns a live view — the children
//   are born hibernated (0 MB) or ghost echoes, so an external agent can
//   never evict the user's live warm pool. add_sticky_note and
//   tidy_region_moodboard are handed to the spatial shell, which applies
//   them through the very store actions the UI uses (addStickyNote /
//   tidyToMoodboard), so undo, persistence and edge consistency hold.
//
// No Electron imports at module level: the pure core and the raw HTTP
// server are unit-tested under `node --test` (browser/tests/); only
// startMcpBridge touches Electron, lazily.

const crypto = require('node:crypto');
const http = require('node:http');

/* ------------------------------------------------------------------ */
/* URL identity — ported 1:1 from app/src/lib/types.ts (§7.6) so a     */
/* url_hash computed here is bit-identical to the shell's.             */
/* ------------------------------------------------------------------ */

/** FNV-1a 32-bit (embed.ts) — the canonical hash primitive. */
function fnv1a32(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const URL_JUNK_PARAMS = Object.freeze([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ref', 'ref_src',
]);

/** Canonical URL identity: strips protocol/www/trailing slash/utm params. */
function canonicalizeUrl(rawUrl) {
  const trimmed = String(rawUrl ?? '').trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    for (const junk of URL_JUNK_PARAMS) parsed.searchParams.delete(junk);
    const query = parsed.searchParams.toString();
    return (
      parsed.host.replace(/^www\./, '') +
      parsed.pathname.replace(/\/+$/, '') +
      (query ? `?${query}` : '')
    );
  } catch {
    return trimmed.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '');
  }
}

/** Canonical `url_hash` (`u` + 8 hex), identical to the shell's urlHashOf. */
function urlHashOf(rawUrl) {
  return `u${fnv1a32(canonicalizeUrl(rawUrl)).toString(16).padStart(8, '0')}`;
}

/** Display domain (host without www) — same rule as the shell's domainOf. */
function domainOf(rawUrl) {
  try {
    return new URL(String(rawUrl ?? '').trim()).host.replace(/^www\./, '');
  } catch {
    const cleaned = String(rawUrl ?? '').trim().replace(/^[a-z]+:\/\//, '');
    return cleaned.split('/')[0] || 'unknown';
  }
}

/* ------------------------------------------------------------------ */
/* Bearer token (per launch, never logged)                             */
/* ------------------------------------------------------------------ */

/** 256-bit url-safe token. Lives only in main-process memory (and in the
 *  env/handshake channel that hands it to the stdio wrapper). */
function generateBridgeToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** `Authorization: Bearer <token>` — returns the raw candidate or null. */
function bearerFromHeaders(headers) {
  const value = headers && typeof headers.authorization === 'string' ? headers.authorization : '';
  const match = /^Bearer[ \t]+(\S+)$/i.exec(value.trim());
  return match ? match[1] : null;
}

/** Constant-time comparison: both sides are SHA-256 digests, so the length
 *  of the secret never leaks through the early-out a raw comparison has. */
function tokenMatches(candidate, token) {
  if (typeof candidate !== 'string' || typeof token !== 'string') return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/* Privacy allowlist — the binding strip                               */
/* ------------------------------------------------------------------ */

/** Why a node must not cross MCP, or null when it may. Every response path
 *  funnels through this: noCapture, viaAuth AND private are all checked so
 *  a future field rename cannot silently widen the surface. */
function stripReason(node) {
  if (!node || typeof node !== 'object') return 'shape';
  if (node.noCapture === true) return 'noCapture';
  if (node.viaAuth === true) return 'viaAuth';
  if (node.private === true) return 'private';
  return null;
}

const EXCERPT_MAX_CHARS = 2048;
const SUB_PAGES_MAX = 32;

/** The public MCP shape of one node. Allowlist: anything not listed here
 *  (thumbnails, media clips, provenance, partition, view mode) never
 *  crosses MCP. `parentUuid` is nulled when the parent itself is stripped;
 *  `childCount` counts only children that survive the strip. */
function sanitizeNodeRecord(node, ctx = {}) {
  if (stripReason(node)) return null;
  const liveUuids = ctx.liveUuids instanceof Set ? ctx.liveUuids : new Set();
  const excerpts = ctx.excerpts instanceof Map ? ctx.excerpts : new Map();
  const visibleUuids = ctx.visibleUuids instanceof Set ? ctx.visibleUuids : null;
  const childUuids = Array.isArray(node.edges) ? node.edges : [];
  const visibleChildren = visibleUuids
    ? childUuids.filter((uuid) => visibleUuids.has(uuid))
    : childUuids;
  const rawExcerpt = typeof node.excerpt === 'string' ? node.excerpt : excerpts.get(node.uuid);
  const subPages = (Array.isArray(node.subPages) ? node.subPages : [])
    .filter((page) => page && typeof page.url === 'string' && page.url.length <= 4096)
    .slice(-SUB_PAGES_MAX)
    .map((page) => ({ url: page.url, at: Number.isFinite(page.at) ? page.at : 0 }));
  return {
    uuid: typeof node.uuid === 'string' ? node.uuid : null,
    urlHash: urlHashOf(node.url),
    url: typeof node.url === 'string' ? node.url : '',
    domain: domainOf(node.url),
    title: typeof node.title === 'string' ? node.title : '',
    x: Number.isFinite(node.x) ? node.x : 0,
    y: Number.isFinite(node.y) ? node.y : 0,
    ramState: liveUuids.has(node.uuid) ? 'live' : 'hibernated',
    excerpt: typeof rawExcerpt === 'string' ? rawExcerpt.slice(0, EXCERPT_MAX_CHARS) : null,
    subPages,
    parentUuid: typeof node.parentUuid === 'string'
      && (!visibleUuids || visibleUuids.has(node.parentUuid))
      ? node.parentUuid
      : null,
    childCount: visibleChildren.length,
    nodeType: node.nodeType === 'ghost-echo' ? 'ghost-echo' : 'tab',
    createdAt: Number.isFinite(node.createdAt) ? node.createdAt : 0,
    lastActiveAt: Number.isFinite(node.lastActiveAt) ? node.lastActiveAt : 0,
  };
}

/** Public shape of a sticky note (user-authored text attached to a
 *  url_hash — the addendum explicitly exposes these). */
function sanitizeNote(note) {
  if (!note || typeof note !== 'object') return null;
  if (typeof note.urlHash !== 'string' || typeof note.text !== 'string') return null;
  return {
    id: typeof note.id === 'string' ? note.id : null,
    urlHash: note.urlHash,
    text: note.text.slice(0, 4000),
    createdAt: Number.isFinite(note.createdAt) ? note.createdAt : 0,
    updatedAt: Number.isFinite(note.updatedAt) ? note.updatedAt : 0,
  };
}

/** Public shape of a region (Flow). */
function sanitizeRegion(region) {
  if (!region || typeof region !== 'object') return null;
  if (typeof region.id !== 'string' || typeof region.name !== 'string') return null;
  return {
    id: region.id,
    name: region.name.slice(0, 120),
    color: typeof region.color === 'string' ? region.color.slice(0, 16) : null,
  };
}

/* ------------------------------------------------------------------ */
/* Search — across live/hibernated nodes, regions and notes            */
/* ------------------------------------------------------------------ */

/** Lowercase word-ish tokens, mirroring the shell's tokenizer breadth
 *  (letters/digits with embedded + # . / -). */
function tokenize(text) {
  return String(text ?? '').toLowerCase().match(/[a-z0-9][a-z0-9+#./-]*/g) ?? [];
}

const SEARCH_DEFAULT_LIMIT = 12;
const SEARCH_MAX_LIMIT = 48;

/** Deterministic pure search over one graphSnapshot. A node matches when
 *  EVERY token hits its title/domain/url; notes match on text, regions on
 *  name. Nodes rank title > domain > url, then recency. */
function searchGraph(snapshot, rawQuery, limit = SEARCH_DEFAULT_LIMIT) {
  const tokens = tokenize(rawQuery).slice(0, 8);
  const max = Math.max(1, Math.min(SEARCH_MAX_LIMIT, Math.round(limit) || SEARCH_DEFAULT_LIMIT));
  if (!tokens.length) return { nodes: [], notes: [], regions: [] };

  const liveUuids = snapshot.liveUuids instanceof Set ? snapshot.liveUuids : new Set();
  const nodes = [];
  for (const node of Array.isArray(snapshot.nodes) ? snapshot.nodes : []) {
    if (stripReason(node)) continue;
    const title = String(node.title ?? '').toLowerCase();
    const domain = domainOf(node.url).toLowerCase();
    const url = String(node.url ?? '').toLowerCase();
    let score = 0;
    let all = true;
    for (const token of tokens) {
      const inTitle = title.includes(token);
      const inDomain = domain.includes(token);
      const inUrl = url.includes(token);
      if (!inTitle && !inDomain && !inUrl) { all = false; break; }
      score += inTitle ? 4 : inDomain ? 2 : 1;
    }
    if (!all) continue;
    if (liveUuids.has(node.uuid)) score += 1;
    nodes.push({ node, score });
  }
  nodes.sort((a, b) => b.score - a.score
    || (b.node.lastActiveAt ?? 0) - (a.node.lastActiveAt ?? 0)
    || String(a.node.uuid).localeCompare(String(b.node.uuid)));

  const notes = (Array.isArray(snapshot.notes) ? snapshot.notes : [])
    .filter((note) => {
      const text = String(note?.text ?? '').toLowerCase();
      return tokens.every((token) => text.includes(token));
    })
    .slice(0, max)
    .map(sanitizeNote)
    .filter(Boolean);

  const regions = (Array.isArray(snapshot.regions) ? snapshot.regions : [])
    .filter((region) => {
      const name = String(region?.name ?? '').toLowerCase();
      return tokens.every((token) => name.includes(token));
    })
    .slice(0, max)
    .map(sanitizeRegion)
    .filter(Boolean);

  return { nodes: nodes.slice(0, max).map((hit) => hit.node), notes, regions };
}

/** 1-hop / 2-hop neighbourhood over the parent/child edges (pure). The
 *  response only ever contains nodes that survive the strip, and only
 *  edges whose BOTH endpoints survive. */
function neighbourhood(snapshot, uuid, maxHops = 2) {
  const hops = maxHops === 1 ? 1 : 2;
  const byUuid = new Map();
  for (const node of Array.isArray(snapshot.nodes) ? snapshot.nodes : []) {
    if (stripReason(node)) continue;
    byUuid.set(node.uuid, node);
  }
  if (!byUuid.has(uuid)) return null;

  const frontier = new Set([uuid]);
  const included = new Set([uuid]);
  for (let depth = 0; depth < hops; depth++) {
    const next = new Set();
    for (const current of frontier) {
      const node = byUuid.get(current);
      if (!node) continue;
      for (const child of Array.isArray(node.edges) ? node.edges : []) {
        if (byUuid.has(child) && !included.has(child)) { next.add(child); included.add(child); }
      }
      const parent = node.parentUuid;
      if (typeof parent === 'string' && byUuid.has(parent) && !included.has(parent)) {
        next.add(parent); included.add(parent);
      }
    }
    frontier.clear();
    for (const added of next) frontier.add(added);
  }

  const edges = [];
  for (const node of byUuid.values()) {
    if (!included.has(node.uuid)) continue;
    for (const child of Array.isArray(node.edges) ? node.edges : []) {
      if (included.has(child)) edges.push({ source: node.uuid, target: child, kind: 'spawn' });
    }
  }
  return { uuids: included, edges };
}

/* ------------------------------------------------------------------ */
/* branch_hibernated_nodes — planning (pure), the url_hash dedupe      */
/* ------------------------------------------------------------------ */

const BRANCH_MAX_TARGETS = 16;
const URL_MAX_LENGTH = 4096;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isValidUrl = (value) => {
  if (typeof value !== 'string' || !value || value.length > URL_MAX_LENGTH) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
};

const clampText = (value, max) => {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);
};

/**
 * Plan one branch call WITHOUT touching state. Dedupe rule (addendum test):
 * a target whose canonical url_hash already exists ANYWHERE in the graph —
 * or twice within the same call — is skipped, never double-spawned.
 *
 * @returns {{ ok: true, parent: object, plan: Array<{url,title,urlHash,parentUuid,x,y,nodeType}>,
 *             skipped: Array<{url,urlHash|null,reason}> } | { ok: false, reason: string }}
 */
function planBranch(snapshot, parentUuid, targets, { born = 'hibernated', siblingCount = 0 } = {}) {
  if (typeof parentUuid !== 'string' || !UUID_PATTERN.test(parentUuid)) {
    return { ok: false, reason: 'invalid-parent' };
  }
  const parent = (Array.isArray(snapshot.nodes) ? snapshot.nodes : []).find((node) => node.uuid === parentUuid);
  // Missing and privacy-excluded parents are indistinguishable on purpose:
  // an agent must not learn that a private node exists.
  if (!parent || stripReason(parent)) return { ok: false, reason: 'unknown-node' };
  if (!Array.isArray(targets) || targets.length === 0) return { ok: false, reason: 'targets' };
  if (targets.length > BRANCH_MAX_TARGETS) return { ok: false, reason: 'too-many-targets' };
  if (born !== 'hibernated' && born !== 'ghost-echo') return { ok: false, reason: 'born' };

  const existingHashes = new Set();
  for (const node of snapshot.nodes ?? []) {
    if (stripReason(node)) continue;
    existingHashes.add(urlHashOf(node.url));
  }

  const plan = [];
  const skipped = [];
  const seenHashes = new Set();
  for (const raw of targets) {
    const target = typeof raw === 'string' ? { url: raw } : raw;
    const url = typeof target?.url === 'string' ? target.url : '';
    if (!isValidUrl(url)) {
      skipped.push({ url: clampText(url, 200), urlHash: null, reason: 'invalid-url' });
      continue;
    }
    const urlHash = urlHashOf(url);
    if (seenHashes.has(urlHash) || existingHashes.has(urlHash)) {
      skipped.push({ url: clampText(url, 200), urlHash, reason: 'duplicate-url-hash' });
      continue;
    }
    seenHashes.add(urlHash);
    const index = siblingCount + plan.length;
    // Same placement law as the UI's link branches (branch-policy.js):
    // step outward on x, alternate rows on y. The parent never moves.
    const x = Math.round((Number.isFinite(parent.x) ? parent.x : 0) + 384 * (index + 1));
    const y = Math.round((Number.isFinite(parent.y) ? parent.y : 0) + 64 * (index % 2 === 0 ? 1 : -1));
    plan.push({
      url,
      title: clampText(target.title, 512) || domainOf(url),
      urlHash,
      parentUuid,
      x,
      y,
      nodeType: born === 'ghost-echo' ? 'ghost-echo' : null,
    });
  }
  return { ok: true, parent: { uuid: parent.uuid, x: parent.x, y: parent.y }, plan, skipped };
}

/* ------------------------------------------------------------------ */
/* Tool surface                                                        */
/* ------------------------------------------------------------------ */

const TOOL_DESCRIPTORS = [
  {
    name: 'get_active_tab',
    description: 'Metadata of the active spatial node: url, title, domain, position, live/hibernated state, the hibernation excerpt, the in-page filmstrip (subPages) and the sticky notes attached to its url_hash. Privacy-excluded (private/noCapture/viaAuth) tabs are indistinguishable from "no active tab".',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_neighbourhood',
    description: 'The 1-hop (or 2-hop) connected nodes and spawn edges around one node uuid. Privacy-excluded nodes are cut from the graph before it is returned.',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: 'uuid of the centre node' },
        hops: { type: 'integer', enum: [1, 2], description: 'default 2' },
      },
      required: ['uuid'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_spatial_graph',
    description: 'Search across all live and hibernated nodes, regions (Flows) and sticky notes. Returns matching nodes, notes and regions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'free text; every token must match' },
        limit: { type: 'integer', description: 'default 12, max 48' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'branch_hibernated_nodes',
    description: 'Spawn child satellite nodes around a parent WITHOUT touching the live warm pool: children are born hibernated (0 MB) or as ghost echoes and never wake a tab. Targets whose canonical url_hash already exists in the graph (or repeats within the call) are skipped, never double-spawned.',
    inputSchema: {
      type: 'object',
      properties: {
        parentUuid: { type: 'string', description: 'uuid of the parent node' },
        targets: {
          type: 'array',
          maxItems: 16,
          items: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              title: { type: 'string' },
            },
            required: ['url'],
            additionalProperties: false,
          },
          description: 'up to 16 http(s) targets',
        },
        born: { type: 'string', enum: ['hibernated', 'ghost-echo'], description: 'default hibernated' },
      },
      required: ['parentUuid', 'targets'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_sticky_note',
    description: 'Attach a sticky note to the canonical url_hash of a url — the same store action the UI uses, so it appears on every duplicate instance of the page.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['url', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'tidy_region_moodboard',
    description: 'Snap a region\'s (Flow\'s) unpinned cards into the 16:10 contact sheet — the same tidyToMoodboard store action the UI uses; pinned anchors and all graph edges are preserved.',
    inputSchema: {
      type: 'object',
      properties: {
        regionId: { type: 'string' },
      },
      required: ['regionId'],
      additionalProperties: false,
    },
  },
];

const NOTE_TEXT_MAX = 4000;
const REGION_ID_MAX = 120;

/** The pure request dispatcher. `effects`:
 *   graphSnapshot() → { nodes, liveUuids, activeUuid, excerpts, notes, regions }
 *   branchHibernated({ parentUuid, children }) → { ok, created?, reason? }
 *   shellCommand({ action, args }) → Promise<{ ok, noteId?, error? }>
 * Every response field is produced by the allowlist helpers above. */
function createMcpCore(effects) {
  if (!effects || typeof effects !== 'object') throw new TypeError('createMcpCore: effects are required');
  const fx = effects;

  const visibleUuidsOf = (snapshot) => {
    const visible = new Set();
    for (const node of Array.isArray(snapshot.nodes) ? snapshot.nodes : []) {
      if (!stripReason(node)) visible.add(node.uuid);
    }
    return visible;
  };

  const toolGetActiveTab = () => {
    const snapshot = fx.graphSnapshot();
    const activeUuid = snapshot.activeUuid;
    const node = activeUuid
      ? (Array.isArray(snapshot.nodes) ? snapshot.nodes : []).find((entry) => entry.uuid === activeUuid)
      : null;
    // A private/noCapture/viaAuth active tab returns exactly what "no
    // active tab" returns — never a hint that an excluded tab exists.
    if (!node || stripReason(node)) return { ok: true, node: null };
    const visibleUuids = visibleUuidsOf(snapshot);
    const sanitized = sanitizeNodeRecord(node, {
      liveUuids: snapshot.liveUuids instanceof Set ? snapshot.liveUuids : new Set(),
      excerpts: snapshot.excerpts instanceof Map ? snapshot.excerpts : new Map(),
      visibleUuids,
    });
    const notes = (Array.isArray(snapshot.notes) ? snapshot.notes : [])
      .filter((note) => note && note.urlHash === sanitized.urlHash)
      .map(sanitizeNote)
      .filter(Boolean);
    return { ok: true, node: { ...sanitized, notes } };
  };

  const toolGetNeighbourhood = (params) => {
    const uuid = params && typeof params.uuid === 'string' && UUID_PATTERN.test(params.uuid)
      ? params.uuid
      : null;
    if (!uuid) return { ok: false, error: 'invalid-uuid' };
    const snapshot = fx.graphSnapshot();
    const result = neighbourhood(snapshot, uuid, params && params.hops === 1 ? 1 : 2);
    // Unknown and privacy-excluded centres are the same error: existence
    // must not leak.
    if (!result) return { ok: false, error: 'unknown-node' };
    const liveUuids = snapshot.liveUuids instanceof Set ? snapshot.liveUuids : new Set();
    const byUuid = new Map((snapshot.nodes ?? []).map((node) => [node.uuid, node]));
    const nodes = [...result.uuids]
      .map((id) => sanitizeNodeRecord(byUuid.get(id), {
        liveUuids,
        excerpts: snapshot.excerpts instanceof Map ? snapshot.excerpts : new Map(),
        visibleUuids: result.uuids,
      }))
      .filter(Boolean);
    return { ok: true, centre: uuid, nodes, edges: result.edges };
  };

  const toolSearch = (params) => {
    const query = params && typeof params.query === 'string' ? params.query : '';
    if (!query.trim()) return { ok: false, error: 'query' };
    const snapshot = fx.graphSnapshot();
    const found = searchGraph(snapshot, query, params && Number.isFinite(params.limit) ? params.limit : SEARCH_DEFAULT_LIMIT);
    const liveUuids = snapshot.liveUuids instanceof Set ? snapshot.liveUuids : new Set();
    const visibleUuids = new Set(found.nodes.map((node) => node.uuid));
    const nodes = found.nodes
      .map((node) => sanitizeNodeRecord(node, {
        liveUuids,
        excerpts: snapshot.excerpts instanceof Map ? snapshot.excerpts : new Map(),
        visibleUuids,
      }))
      .filter(Boolean);
    return { ok: true, nodes, notes: found.notes, regions: found.regions };
  };

  const toolBranch = async (params) => {
    const parentUuid = params && typeof params.parentUuid === 'string' ? params.parentUuid : null;
    const born = params && params.born === 'ghost-echo' ? 'ghost-echo' : 'hibernated';
    const snapshot = fx.graphSnapshot();
    // Sibling count for placement: the parent's surviving children.
    const parent = (Array.isArray(snapshot.nodes) ? snapshot.nodes : []).find((node) => node.uuid === parentUuid);
    const siblingCount = parent && Array.isArray(parent.edges)
      ? parent.edges.filter((child) => {
        const childNode = (snapshot.nodes ?? []).find((node) => node.uuid === child);
        return childNode && !stripReason(childNode);
      }).length
      : 0;
    const planned = planBranch(snapshot, parentUuid, params ? params.targets : null, {
      born,
      siblingCount,
    });
    if (!planned.ok) return { ok: false, error: planned.reason };
    if (planned.plan.length === 0) {
      return { ok: true, created: [], skipped: planned.skipped, parentUuid };
    }
    const applied = await fx.branchHibernated({ parentUuid, children: planned.plan });
    if (!applied || applied.ok !== true) {
      return { ok: false, error: (applied && applied.reason) || 'apply-failed' };
    }
    const liveUuids = snapshot.liveUuids instanceof Set ? snapshot.liveUuids : new Set();
    return {
      ok: true,
      parentUuid,
      created: (Array.isArray(applied.created) ? applied.created : [])
        .map((node) => sanitizeNodeRecord(node, { liveUuids, visibleUuids: null, excerpts: new Map() }))
        .filter(Boolean),
      skipped: planned.skipped,
    };
  };

  const toolAddStickyNote = async (params) => {
    const url = params && typeof params.url === 'string' ? params.url : '';
    const text = params && typeof params.text === 'string' ? params.text : '';
    if (!isValidUrl(url)) return { ok: false, error: 'invalid-url' };
    if (!text.trim()) return { ok: false, error: 'text' };
    const urlHash = urlHashOf(url);
    // The shell applies this through useGraphStore.addStickyNote — the SAME
    // action the UI uses — so persistence/undo semantics are the UI's own.
    const result = await fx.shellCommand({ action: 'addStickyNote', args: { urlHash, text: text.slice(0, NOTE_TEXT_MAX) } });
    if (!result || result.ok !== true) {
      return { ok: false, error: (result && result.error) || 'shell-unavailable', urlHash };
    }
    return { ok: true, urlHash, noteId: result.noteId ?? null };
  };

  const toolTidyRegion = async (params) => {
    const regionId = params && typeof params.regionId === 'string' ? params.regionId.trim() : '';
    if (!regionId || regionId.length > REGION_ID_MAX) return { ok: false, error: 'invalid-region' };
    const snapshot = fx.graphSnapshot();
    const known = (Array.isArray(snapshot.regions) ? snapshot.regions : [])
      .some((region) => region && region.id === regionId);
    if (!known) return { ok: false, error: 'unknown-region' };
    const result = await fx.shellCommand({ action: 'tidyToMoodboard', args: { regionId } });
    if (!result || result.ok !== true) {
      return { ok: false, error: (result && result.error) || 'shell-unavailable' };
    }
    return { ok: true, regionId };
  };

  const tools = new Map([
    ['get_active_tab', toolGetActiveTab],
    ['get_neighbourhood', toolGetNeighbourhood],
    ['search_spatial_graph', toolSearch],
    ['branch_hibernated_nodes', toolBranch],
    ['add_sticky_note', toolAddStickyNote],
    ['tidy_region_moodboard', toolTidyRegion],
  ]);

  /** Handle one JSON-RPC request object → response object (or null for
   *  notifications). Never throws: failures become JSON-RPC errors. */
  const handleRequest = async (request) => {
    if (!request || typeof request !== 'object' || typeof request.method !== 'string') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const { id, method, params } = request;
    const respond = (result) => ({ jsonrpc: '2.0', id: id ?? null, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

    if (method === 'initialize') {
      const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
      const supported = ['2025-06-18', '2024-11-05'];
      return respond({
        protocolVersion: supported.includes(requested) ? requested : supported[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'spatial-browser', version: '1.48.0' },
      });
    }
    if (method === 'notifications/initialized') return null;
    if (method === 'ping') return respond({});

    if (method === 'tools/list') {
      return respond({ tools: TOOL_DESCRIPTORS });
    }
    if (method === 'tools/call') {
      const name = params && typeof params.name === 'string' ? params.name : null;
      const handler = name ? tools.get(name) : null;
      if (!handler) return fail(-32602, `Unknown tool: ${String(name)}`);
      try {
        const payload = await handler(params && typeof params.arguments === 'object' ? params.arguments : {});
        return respond({
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          isError: payload && payload.ok === false ? true : undefined,
        });
      } catch (error) {
        // Never let an effect failure leak internals — and never log the
        // token (nothing here ever holds it).
        return respond({
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'internal-error' }) }],
          isError: true,
        });
      }
    }
    return fail(-32601, `Method not found: ${method}`);
  };

  return { handleRequest, tools: TOOL_DESCRIPTORS };
}

/* ------------------------------------------------------------------ */
/* HTTP transport (raw node:http — unit-testable without Electron)     */
/* ------------------------------------------------------------------ */

const BODY_MAX_BYTES = 256 * 1024;

const isLoopback = (remoteAddress) =>
  remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';

/**
 * Raw bearer-gated HTTP server for one core. Every call requires the
 * per-launch token; nothing about the failure mode distinguishes a bad
 * token from a missing one.
 */
function createHttpServer({ core, token }) {
  if (!core || typeof core.handleRequest !== 'function') throw new TypeError('createHttpServer: core.handleRequest is required');
  if (typeof token !== 'string' || !token) throw new TypeError('createHttpServer: token is required');
  const server = http.createServer((req, res) => {
    const deny = (status) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: status === 401 ? 'unauthorized' : 'forbidden' }));
    };
    if (!isLoopback(req.socket.remoteAddress)) return deny(403);
    if ((req.method ?? 'GET') !== 'POST') return deny(405);
    if (req.url !== '/' && req.url !== '/mcp') return deny(404);
    if (!tokenMatches(bearerFromHeaders(req.headers), token)) return deny(401);

    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_MAX_BYTES) {
        aborted = true;
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload-too-large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', async () => {
      if (aborted) return;
      let request;
      try {
        request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        return;
      }
      const response = await core.handleRequest(request);
      if (!response) {
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
    });
    req.on('error', () => { /* a torn-down socket is not fatal */ });
  });
  return server;
}

/* ------------------------------------------------------------------ */
/* Shell-synced notes/regions + shell commands (Electron wiring)       */
/* ------------------------------------------------------------------ */

const NOTES_SYNC_MAX = 512;
const REGIONS_SYNC_MAX = 64;

/** Validate the shell's notes/regions snapshot into the main-side cache
 *  (memory only — never persisted, never on disk). */
function normalizeShellState(raw) {
  const notes = (Array.isArray(raw?.notes) ? raw.notes : [])
    .slice(0, NOTES_SYNC_MAX)
    .map(sanitizeNote)
    .filter(Boolean);
  const regions = (Array.isArray(raw?.regions) ? raw.regions : [])
    .slice(0, REGIONS_SYNC_MAX)
    .map(sanitizeRegion)
    .filter(Boolean);
  return { notes, regions };
}

const SHELL_COMMAND_TIMEOUT_MS = 2500;

/** The main→shell command path for the two store-side write tools.
 *  Broadcasts one trust-gated spatial:* message; the spatial shell applies
 *  it through its own store actions and acks. */
function createShellCommandChannel({ chromeHandle, chromeOn, broadcast, shellsAlive }) {
  if (typeof chromeHandle !== 'function' || typeof chromeOn !== 'function') {
    throw new TypeError('createShellCommandChannel: chromeHandle and chromeOn are required');
  }
  if (typeof broadcast !== 'function' || typeof shellsAlive !== 'function') {
    throw new TypeError('createShellCommandChannel: broadcast and shellsAlive are required');
  }
  const pending = new Map();
  // Registrar callbacks receive (event, payload) — payload is args[1].
  chromeOn('spatial:mcp:command:ack', (...args) => {
    const payload = args[1];
    const id = payload && typeof payload.id === 'string' ? payload.id : null;
    const entry = id ? pending.get(id) : null;
    if (!entry) return;
    pending.delete(id);
    entry.resolve({
      ok: payload.ok === true,
      noteId: typeof payload.noteId === 'string' ? payload.noteId : null,
    });
  });
  const shellCommand = ({ action, args }) => new Promise((resolve) => {
    if (!shellsAlive()) return resolve({ ok: false, error: 'shell-unavailable' });
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      if (pending.delete(id)) resolve({ ok: false, error: 'shell-ack-timeout' });
    }, SHELL_COMMAND_TIMEOUT_MS);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); } });
    broadcast('spatial:mcp:command', { id, action, args });
  });
  return { shellCommand };
}

/* ------------------------------------------------------------------ */
/* startMcpBridge — the one call main.js makes                         */
/* ------------------------------------------------------------------ */

/**
 * Start the local MCP bridge. Called ONCE from main.js after
 * spatialRuntime.initSpatial(...). deps (from spatialRuntime.mcpBridgeEffects()):
 *   graphSnapshot(), branchHibernated(), shellBroadcast(), shellsAlive(),
 *   chromeHandle(), chromeOn(), userDataPath
 * plus `app` (Electron app, for the will-quit handshake cleanup).
 *
 * Returns { port, close() } — port for tests/diagnostics; the TOKEN is
 * deliberately NOT returned: it never leaves this closure except through
 * the stdio wrapper's env / handshake file.
 */
function startMcpBridge(deps) {
  const electron = require('electron');
  const path = require('node:path');
  const fs = require('node:fs');
  const app = deps?.app ?? electron.app;
  const d = deps ?? {};
  const shellState = { notes: [], regions: [] };

  // Shell → main: notes/regions snapshot (user-authored content only).
  d.chromeOn?.('spatial:mcp:notes:sync', (...args) => {
    const next = normalizeShellState(args[1]);
    shellState.notes = next.notes;
    shellState.regions = next.regions;
  });

  const { shellCommand } = createShellCommandChannel({
    chromeHandle: d.chromeHandle,
    chromeOn: d.chromeOn,
    broadcast: d.shellBroadcast,
    shellsAlive: d.shellsAlive,
  });

  const core = createMcpCore({
    graphSnapshot: () => {
      const snapshot = d.graphSnapshot();
      return { ...snapshot, notes: shellState.notes, regions: shellState.regions };
    },
    branchHibernated: d.branchHibernated,
    shellCommand,
  });

  const token = generateBridgeToken();
  const server = createHttpServer({ core, token });

  // Per-launch handshake for the stdio wrapper: 0600, inside userData,
  // deleted when the browser quits — a stale token never survives a run.
  let bridgeFile = null;
  if (typeof d.userDataPath === 'string' && d.userDataPath) {
    try {
      const dir = path.join(d.userDataPath, 'spatial-mcp');
      fs.mkdirSync(dir, { recursive: true });
      bridgeFile = path.join(dir, 'bridge.json');
    } catch { /* read-only userData: the env handoff still works */ }
  }
  const writeHandshake = (port) => {
    if (!bridgeFile) return;
    try {
      fs.writeFileSync(bridgeFile, JSON.stringify({
        spec: 1, port, token, pid: process.pid, startedAt: Date.now(),
      }), { mode: 0o600 });
    } catch { /* best effort — env handoff is the primary channel */ }
  };
  const removeHandshake = () => {
    if (!bridgeFile) return;
    try { fs.rmSync(bridgeFile, { force: true }); } catch { /* already gone */ }
  };

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      writeHandshake(port);
      // The one log line this module ever emits — port only, never the token.
      console.log(`[spatial-mcp] bridge listening on 127.0.0.1:${port}`);
      app?.once?.('will-quit', removeHandshake);
      resolve({
        port,
        close: () => { removeHandshake(); server.close(); },
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* stdio CLI wrapper — `node mcp-server.js --stdio`                    */
/*                                                                     */
/* An MCP client spawns this as a plain node process. It forwards      */
/* newline-delimited JSON-RPC from stdin to the browser's HTTP bridge. */
/* Token resolution order:                                             */
/*   1. SPATIAL_MCP_PORT + SPATIAL_MCP_TOKEN env   (browser-spawned)   */
/*   2. SPATIAL_MCP_BRIDGE_FILE env                (explicit path)     */
/*   3. <userData>/spatial-mcp/bridge.json         (per-launch file)   */
/* The wrapper never logs the token and never writes anything.         */
/* ------------------------------------------------------------------ */

function readBridgeFile(explicitPath) {
  const fs = require('node:fs');
  const path = require('node:path');
  const candidates = [];
  if (explicitPath) candidates.push(explicitPath);
  try {
    const pkg = require('../package.json');
    const home = require('node:os').homedir();
    const appData = process.env.APPDATA
      || (process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : process.platform === 'linux'
          ? path.join(home, '.config')
          : path.join(home, 'AppData', 'Roaming'));
    candidates.push(path.join(appData, pkg.productName || pkg.name || 'Spatial', 'spatial-mcp', 'bridge.json'));
  } catch { /* no package.json beside the wrapper */ }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (Number.isFinite(parsed.port) && typeof parsed.token === 'string' && parsed.token) {
        return { port: parsed.port, token: parsed.token };
      }
    } catch { /* try the next candidate */ }
  }
  return null;
}

function resolveBridgeEndpoint() {
  const envPort = Number(process.env.SPATIAL_MCP_PORT);
  const envToken = process.env.SPATIAL_MCP_TOKEN;
  if (Number.isFinite(envPort) && envPort > 0 && typeof envToken === 'string' && envToken) {
    return { port: envPort, token: envToken };
  }
  return readBridgeFile(process.env.SPATIAL_MCP_BRIDGE_FILE || undefined);
}

async function httpCall({ port, token }, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        authorization: `Bearer ${token}`,
      },
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { resolve({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Bad bridge response' } }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('bridge timeout')));
    req.on('error', (error) => {
      resolve({
        jsonrpc: '2.0',
        id: payload && payload.id !== undefined ? payload.id : null,
        error: { code: -32603, message: 'Bridge unreachable — is the Spatial browser running?' },
      });
      void error;
    });
    req.end(body);
  });
}

/** The CLI loop: one JSON-RPC request per stdin line, one response line. */
function runStdioWrapper(io = process) {
  const endpoint = resolveBridgeEndpoint();
  if (!endpoint) {
    io.stderr.write('[spatial-mcp] no bridge endpoint: start the Spatial browser first '
      + '(or set SPATIAL_MCP_PORT + SPATIAL_MCP_TOKEN).\n');
    io.exit(1);
    return;
  }
  let buffer = '';
  let inFlight = 0;
  let stdinEnded = false;
  const maybeExit = () => { if (stdinEnded && inFlight === 0) io.exit(0); };
  const handleLine = async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request;
    try { request = JSON.parse(trimmed); } catch {
      io.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      return;
    }
    inFlight += 1;
    try {
      const response = await httpCall(endpoint, request);
      if (request && request.id !== undefined && request.id !== null) {
        io.stdout.write(`${JSON.stringify(response)}\n`);
      }
    } finally {
      inFlight -= 1;
      maybeExit();
    }
  };
  io.stdin.setEncoding('utf8');
  io.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newlineAt = buffer.indexOf('\n');
    while (newlineAt !== -1) {
      const line = buffer.slice(0, newlineAt);
      buffer = buffer.slice(newlineAt + 1);
      void handleLine(line);
      newlineAt = buffer.indexOf('\n');
    }
  });
  io.stdin.on('end', () => { stdinEnded = true; maybeExit(); });
}

if (require.main === module && process.argv.includes('--stdio')) {
  runStdioWrapper();
}

module.exports = {
  // pure core + helpers (unit-tested)
  createMcpCore,
  createHttpServer,
  generateBridgeToken,
  bearerFromHeaders,
  tokenMatches,
  stripReason,
  sanitizeNodeRecord,
  sanitizeNote,
  sanitizeRegion,
  searchGraph,
  neighbourhood,
  planBranch,
  normalizeShellState,
  urlHashOf,
  canonicalizeUrl,
  domainOf,
  TOOL_DESCRIPTORS,
  // electron wiring + CLI
  startMcpBridge,
  createShellCommandChannel,
  runStdioWrapper,
};
