'use strict';

// Pure node-graph model for the Spatial shell (Phase 3, spec steps 2–3).
//
// The MAIN process owns the spatial node graph: every node is one browser tab
// (a WebContentsView when live, a quiet/hibernated record otherwise). This
// module holds the graph state and the warm-pool/capture policies as pure,
// unit-testable functions — no Electron imports, no IPC, no disk. The
// Electron-side owner is spatial-runtime.js; the IPC seam is graph-ipc.js.

const { MODE_B_THUMB } = require('./canvas-layout');
const { MAX_SUB_PAGES } = require('./branch-policy');
const { normalizePartitionField } = require('./session-partitions');

// Mode A warm pool (spec: ≤ 6 live WebContentsViews): the active node plus
// LIVE_POOL_LIMIT background nodes, LRU-auto-quieted through Blanc's own
// sleepTab/wakeTab machinery.
const LIVE_POOL_LIMIT = 5;
const MAX_LIVE_VIEWS = LIVE_POOL_LIMIT + 1;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isUuid = (value) => typeof value === 'string' && UUID_PATTERN.test(value);
const clampCoordinate = (value) => {
  if (!isFiniteNumber(value)) return 0;
  // The spatial canvas is infinite in principle; clamp to a sane signed range
  // so a hostile or drifting payload can never store absurd magnitudes.
  return Math.max(-1_000_000, Math.min(1_000_000, Math.round(value)));
};
const clampSize = (value) => {
  if (!isFiniteNumber(value) || value <= 0) return 0;
  return Math.min(4096, Math.round(value));
};

/** A validated graph node. Unknown fields are dropped, never trusted. */
function normalizeNode(input) {
  if (!input || typeof input !== 'object') return null;
  const url = typeof input.url === 'string' && input.url.length <= 4096 ? input.url : '';
  if (!url) return null;
  const edges = Array.isArray(input.edges)
    ? [...new Set(input.edges.filter(isUuid))].slice(0, 256)
    : [];
  return {
    uuid: isUuid(input.uuid) ? input.uuid : null,
    url,
    title: typeof input.title === 'string' ? input.title.slice(0, 512) : '',
    x: clampCoordinate(input.x),
    y: clampCoordinate(input.y),
    w: clampSize(input.w),
    h: clampSize(input.h),
    parentUuid: isUuid(input.parentUuid) ? input.parentUuid : null,
    edges,
    mode: input.mode === 'canvas' ? 'canvas' : 'reading',
    pinned: input.pinned === true,
    private: input.private === true,
    // §B.8.4 — optional session partition ('default' | 'sandbox' |
    // 'persist:region-<id>'). Unknown values drop to null: the live view then
    // uses the profile's ordinary session. session-partitions.js owns the
    // policy; the model only normalizes what it persists.
    partition: normalizePartitionField(input.partition),
    // Link branching (branch-policy.js): how this node came into being, and
    // whether it stands for a collapsed OAuth/SSO/payment chain.
    branchKind: input.branchKind === 'link' || input.branchKind === 'auth' ? input.branchKind : null,
    viaAuth: input.viaAuth === true,
    // SPA filmstrip: same-document (pushState) commits, capped. Each record
    // keeps only its url and timestamp; anything else is dropped.
    subPages: (Array.isArray(input.subPages) ? input.subPages : [])
      .filter((page) => page && typeof page.url === 'string' && page.url.length <= 4096)
      .slice(-MAX_SUB_PAGES)
      .map((page) => ({ url: page.url, at: isFiniteNumber(page.at) ? page.at : 0 })),
    createdAt: isFiniteNumber(input.createdAt) ? input.createdAt : 0,
    thumb: typeof input.thumb === 'string' && input.thumb.length <= 512 * 1024
      ? input.thumb
      : null,
    lastActiveAt: isFiniteNumber(input.lastActiveAt) ? input.lastActiveAt : 0,
  };
}

/**
 * The graph model. Nodes live in a Map keyed by uuid; edges are stored on the
 * parent record (`edges` = child uuids) so a node record is self-contained
 * for session persistence.
 */
function createGraphModel(initialNodes = []) {
  const nodes = new Map();
  for (const raw of (Array.isArray(initialNodes) ? initialNodes : [])) {
    const node = normalizeNode(raw);
    if (node && node.uuid && !nodes.has(node.uuid)) nodes.set(node.uuid, node);
  }

  const serialize = () => [...nodes.values()].map((node) => ({ ...node, edges: [...node.edges] }));

  /** Apply one validated op; returns `{ ok, changed, reason? }`. */
  const applyOp = (op) => {
    if (!op || typeof op !== 'object') return { ok: false, reason: 'shape' };
    switch (op.type) {
      case 'add': {
        const node = normalizeNode(op.node);
        if (!node) return { ok: false, reason: 'node' };
        if (!node.uuid) return { ok: false, reason: 'uuid' };
        if (nodes.has(node.uuid)) return { ok: false, reason: 'duplicate' };
        if (node.parentUuid && !nodes.has(node.parentUuid)) node.parentUuid = null;
        nodes.set(node.uuid, node);
        if (node.parentUuid) {
          const parent = nodes.get(node.parentUuid);
          if (!parent.edges.includes(node.uuid)) parent.edges.push(node.uuid);
        }
        return { ok: true, changed: true };
      }
      case 'move': {
        if (!isUuid(op.uuid)) return { ok: false, reason: 'uuid' };
        const node = nodes.get(op.uuid);
        if (!node) return { ok: false, reason: 'missing' };
        node.x = clampCoordinate(op.x);
        node.y = clampCoordinate(op.y);
        return { ok: true, changed: true };
      }
      case 'patch': {
        if (!isUuid(op.uuid) || !op.patch || typeof op.patch !== 'object') {
          return { ok: false, reason: 'shape' };
        }
        const node = nodes.get(op.uuid);
        if (!node) return { ok: false, reason: 'missing' };
        if (typeof op.patch.title === 'string') node.title = op.patch.title.slice(0, 512);
        if (typeof op.patch.url === 'string' && op.patch.url.length <= 4096 && op.patch.url) {
          node.url = op.patch.url;
        }
        if (op.patch.pinned === true || op.patch.pinned === false) node.pinned = op.patch.pinned;
        if (op.patch.viaAuth === true) node.viaAuth = true;
        if (op.patch.branchKind === 'link' || op.patch.branchKind === 'auth') node.branchKind = op.patch.branchKind;
        if (Array.isArray(op.patch.subPages)) {
          // Full replacement, validated like normalizeNode: the runtime
          // builds the filmstrip via appendSubPage and sends the result.
          node.subPages = op.patch.subPages
            .filter((page) => page && typeof page.url === 'string' && page.url.length <= 4096)
            .slice(-MAX_SUB_PAGES)
            .map((page) => ({ url: page.url, at: isFiniteNumber(page.at) ? page.at : 0 }));
        }
        return { ok: true, changed: true };
      }
      case 'remove': {
        if (!isUuid(op.uuid)) return { ok: false, reason: 'uuid' };
        const node = nodes.get(op.uuid);
        if (!node) return { ok: false, reason: 'missing' };
        // Orphaned children become roots; the parent's edge row is removed.
        for (const uuid of node.edges) {
          const child = nodes.get(uuid);
          if (child && child.parentUuid === node.uuid) child.parentUuid = null;
        }
        if (node.parentUuid) {
          const parent = nodes.get(node.parentUuid);
          if (parent) parent.edges = parent.edges.filter((uuid) => uuid !== node.uuid);
        }
        nodes.delete(node.uuid);
        return { ok: true, changed: true };
      }
      case 'connect': {
        if (!isUuid(op.parentUuid) || !isUuid(op.childUuid)) return { ok: false, reason: 'uuid' };
        const parent = nodes.get(op.parentUuid);
        const child = nodes.get(op.childUuid);
        if (!parent || !child) return { ok: false, reason: 'missing' };
        if (op.parentUuid === op.childUuid) return { ok: false, reason: 'self' };
        // A node has one parent: re-parenting detaches the previous edge.
        if (child.parentUuid && child.parentUuid !== op.parentUuid) {
          const previous = nodes.get(child.parentUuid);
          if (previous) previous.edges = previous.edges.filter((uuid) => uuid !== child.uuid);
        }
        child.parentUuid = op.parentUuid;
        if (!parent.edges.includes(child.uuid)) parent.edges.push(child.uuid);
        return { ok: true, changed: true };
      }
      case 'activate': {
        if (!isUuid(op.uuid)) return { ok: false, reason: 'uuid' };
        const node = nodes.get(op.uuid);
        if (!node) return { ok: false, reason: 'missing' };
        node.lastActiveAt = isFiniteNumber(op.at) ? op.at : Date.now();
        return { ok: true, changed: true };
      }
      default:
        return { ok: false, reason: 'type' };
    }
  };

  /** Apply a batch; stops at the first rejected op. */
  const applyOps = (ops) => {
    for (const op of (Array.isArray(ops) ? ops : [])) {
      const result = applyOp(op);
      if (!result.ok) return { ok: false, reason: result.reason, applied: ops.indexOf(op) };
    }
    return { ok: true, changed: nodes.size > 0 };
  };

  return { nodes, applyOp, applyOps, serialize };
}

/**
 * Warm-pool eviction policy. `live` is an ordered array of
 * `{ uuid, tabId, lastUsedAt, isActive }`; a candidate must exist in the
 * graph, and pinned/audible/private-capturing nodes are immune. Returns the
 * LRU uuid to quiet, or null when the pool is within its limit or everything
 * is immune.
 */
function pickEvictionCandidate(live, model, { maxLive = MAX_LIVE_VIEWS } = {}) {
  if (!Array.isArray(live) || !model || !(model.nodes instanceof Map)) return null;
  const liveCount = live.filter((entry) => entry && entry.uuid && entry.tabId != null).length;
  if (liveCount <= maxLive) return null;
  const now = Date.now();
  const candidates = live
    .filter((entry) => {
      if (!entry || !entry.uuid || entry.tabId == null || entry.isActive) return false;
      const node = model.nodes.get(entry.uuid);
      if (!node) return false;
      // Audibility is a TAB property (tab.audible), surfaced on the ENTRY by
      // the runtime — a graph node has no isAudible field, so reading it off
      // the node always saw undefined and an audible tab was evictable.
      return !node.pinned && !node.private && entry.isAudible !== true;
    })
    .sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
  if (!candidates.length) return null;
  void now;
  return candidates[0].uuid;
}

/** Node's LRU touch time for pool ordering (graph value first, live ref second). */
function lastUsedAtFor(node, entry) {
  const a = node && isFiniteNumber(node.lastActiveAt) ? node.lastActiveAt : 0;
  const b = entry && isFiniteNumber(entry.lastUsedAt) ? entry.lastUsedAt : 0;
  return Math.max(a, b);
}

/**
 * Mode B capture policy (spec: 640×400 WebP per node, navEpoch-guarded,
 * noCapture/private skipped). Private nodes are the noCapture class — they
 * never write thumbnails or excerpts to disk.
 */
function shouldCaptureNode(node, tab, { requireLive = true, isLive = true } = {}) {
  if (!node || node.private === true || node.noCapture === true) return false;
  if (requireLive && !isLive) return false;
  if (tab && tab.private === true) return false;
  return true;
}

/** The capture target size (from canvas-layout) for Mode B thumbnails. */
const captureSize = () => ({ ...MODE_B_THUMB });

/**
 * The session v3 `spatialNodes` column for one window: one record per
 * persisted tab, aligned to the entry (urls) order —
 * `{ uuid, x, y, w, h, parentUuid, edges }` per the spec. `tabIdByUuid` is
 * the runtime's live uuid→tabId mapping (tab ids never leave the process).
 * Returns null when the window has no spatial records, so unstamped windows
 * keep the v2 shape.
 */
function sessionNodesForTabIds(model, tabIds, tabIdByUuid) {
  if (!model || !(model.nodes instanceof Map) || !Array.isArray(tabIds)) return null;
  const byUuid = tabIdByUuid instanceof Map ? tabIdByUuid : new Map();
  const records = tabIds.map((tabId) => {
    if (tabId == null) return null;
      for (const node of model.nodes.values()) {
        if (byUuid.get(node.uuid) === tabId) {
          return {
            uuid: node.uuid,
            x: node.x,
            y: node.y,
            w: node.w,
            h: node.h,
            parentUuid: node.parentUuid,
            edges: [...node.edges],
            branchKind: node.branchKind,
            viaAuth: node.viaAuth,
            // §B.8.4 — the sandbox label survives session capture/restore,
            // else a sandbox node resurrects as an ordinary dead https tab.
            partition: normalizePartitionField(node.partition),
            subPages: [...node.subPages],
            createdAt: node.createdAt,
          };
        }
      }
    return null;
  });
  if (!records.some(Boolean)) return null;
  return records;
}

/**
 * Parse a saved `spatialNodes` column (session v3) back into node records
 * ready for graph hydration. A missing/blank slot stays null; invalid records
 * never shift onto a neighbour.
 */
function parseSessionNodes(column) {
  if (!Array.isArray(column)) return [];
  return column.map((record) => {
    if (!record || typeof record !== 'object' || !isUuid(record.uuid)) return null;
    return {
      uuid: record.uuid,
      x: clampCoordinate(record.x),
      y: clampCoordinate(record.y),
      w: clampSize(record.w),
      h: clampSize(record.h),
      parentUuid: isUuid(record.parentUuid) ? record.parentUuid : null,
      edges: Array.isArray(record.edges) ? record.edges.filter(isUuid) : [],
      branchKind: record.branchKind === 'link' || record.branchKind === 'auth' ? record.branchKind : null,
      viaAuth: record.viaAuth === true,
      partition: normalizePartitionField(record.partition),
      subPages: (Array.isArray(record.subPages) ? record.subPages : [])
        .filter((page) => page && typeof page.url === 'string' && page.url.length <= 4096)
        .slice(-MAX_SUB_PAGES)
        .map((page) => ({ url: page.url, at: isFiniteNumber(page.at) ? page.at : 0 })),
      createdAt: isFiniteNumber(record.createdAt) ? record.createdAt : 0,
    };
  });
}

module.exports = {
  LIVE_POOL_LIMIT,
  MAX_LIVE_VIEWS,
  UUID_PATTERN,
  normalizeNode,
  createGraphModel,
  pickEvictionCandidate,
  lastUsedAtFor,
  shouldCaptureNode,
  captureSize,
  sessionNodesForTabIds,
  parseSessionNodes,
};
