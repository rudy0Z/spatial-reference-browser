'use strict';

// Electron-side owner of the Spatial shell (Phase 3, spec steps 2–3).
//
// The spatial document (blanc-chrome://spatial/, built from app/) is the
// window chrome: BrowserTopBar (48px) + ZenRail (224/0px) + FloatingIslandPill
// + canvas are its DOM. Every live page is a Blanc WebContentsView created
// through main.js's own tab model (createTab/sleepTab/wakeTab), so Quiet Tabs,
// audio immunity, session capture and blocker wiring all keep working; this
// module only positions the views (a resizeNodes() analog of resizeActiveView),
// enforces the ≤ 6 warm pool, runs the Mode B capture pipeline, and guards
// native z-order under DOM overlays.
//
// Pure policy lives in node-model.js / canvas-layout.js; the IPC contract
// lives in graph-ipc.js. All Blanc state is injected once via initSpatial()
// from main.js (thin hooks — this file never reaches into main's closures).

const path = require('node:path');

const { JsonStore } = require('../store');
const { CHROME_SPATIAL_URL } = require('../chrome-protocol');
const {
  createGraphModel,
  normalizeNode,
  parseSessionNodes,
  sessionNodesForTabIds,
  pickEvictionCandidate,
  MAX_LIVE_VIEWS,
  shouldCaptureNode,
} = require('./node-model');
const { modeAViewBounds, sanitizeChromeLayout, isCanvasMode } = require('./canvas-layout');
const { createGraphIpc } = require('./graph-ipc');

// uuid → live tab id. Tab ids are process-local; entries for dead tabs are
// pruned lazily and never persist (the session column carries uuids only).
const tabIdByUuid = new Map();

// Flip SPATIAL_CHROME=0 to fall back to the strip chrome (rollback path).
const spatialChromeEnabled = () => process.env.SPATIAL_CHROME !== '0';

const spatialPreloadPath = () => path.join(__dirname, 'spatial-preload.js');

let deps = null;
let model = null;
let store = null;

/* ------------------------------------------------------------------ */
/* State (per runtime, on runtime.* so window teardown needs no map)    */
/*   runtime.spatialChrome      — this window runs the spatial shell   */
/*   runtime.spatialChromeLayout— last validated renderer layout       */
/*   runtime.spatialMode        — 'reading' | 'canvas'                 */
/*   runtime.spatialGuard       — z-order guard engaged (view hidden)  */
/*   runtime.spatialLive        — Map<uuid, {tabId, lastUsedAt}>       */
/*   runtime.spatialActiveUuid  — active node uuid                     */
/* ------------------------------------------------------------------ */

const liveMap = (runtime) => {
  if (!runtime.spatialLive) runtime.spatialLive = new Map();
  return runtime.spatialLive;
};

/** Serialization of the whole graph for the renderer (thumbnails included). */
const serializeGraph = () => ({
  version: 1,
  nodes: model.serialize(),
});

/** Push the graph to every live spatial chrome document. */
function broadcastGraph() {
  for (const runtime of deps.allRuntimes()) {
    if (runtime.spatialChrome && runtime.window && !runtime.window.isDestroyed()) {
      runtime.window.webContents.send('spatial:graph:updated', serializeGraph());
    }
  }
}

const persistGraph = () => {
  // JsonStore.update mutates the entry in place and schedules the debounced
  // save — the returned value is discarded, so write through the record.
  store.update((data) => {
    data.version = 1;
    data.nodes = model.serialize();
  });
};

/* ------------------------------------------------------------------ */
/* Live-view pool (Mode A)                                             */
/* ------------------------------------------------------------------ */

function liveEntries(runtime) {
  const live = liveMap(runtime);
  const entries = [];
  for (const [uuid, entry] of live) {
    const tab = deps.tabs.get(entry.tabId);
    if (!tab) { live.delete(uuid); continue; }
    entries.push({
      uuid,
      tabId: entry.tabId,
      lastUsedAt: entry.lastUsedAt ?? 0,
      isActive: runtime.spatialActiveUuid === uuid,
      isAudible: tab.isAudible === true,
    });
  }
  return entries;
}

/** Touch the LRU clock for a node's live view. */
function touchLive(runtime, uuid) {
  const live = liveMap(runtime);
  const entry = live.get(uuid);
  if (entry) entry.lastUsedAt = Date.now();
}

/**
 * Enforce the ≤ 6 live-view pool by quieting the LRU candidate through
 * Blanc's own sleepTab (renderer discarded, ~148 MB reclaimed, snapshot kept
 * for wake). The active node and pinned/audible/private nodes are immune.
 */
function enforceLivePool(runtime) {
  const evictUuid = pickEvictionCandidate(liveEntries(runtime), model, { maxLive: MAX_LIVE_VIEWS });
  if (!evictUuid) return;
  const live = liveMap(runtime);
  const entry = live.get(evictUuid);
  live.delete(evictUuid);
  if (entry) {
    try { deps.sleepTab(entry.tabId); } catch { /* tab may be mid-teardown */ }
  }
}

// The app shell's fresh-state "New Tab" node maps onto Blanc's own new-tab
// page when it becomes a live view (the spatial host cannot serve
// https://new-tab.spatial/local — it is an identity, not an address).
const NEW_TAB_NODE_URL = 'https://new-tab.spatial/local';
const urlForTab = (node) => (node.url === NEW_TAB_NODE_URL ? 'blanc://newtab' : node.url);

/**
 * Keep the graph node in lockstep with its tab's committed location and
 * title (the tab model already tracks the rest of the navigation state).
 */
function wireGraphNodeSync(tabId, uuid) {
  const tab = deps.tabs.get(tabId);
  const wc = tab ? deps.liveContents(tab) : null;
  if (!wc) return;
  wc.on('did-navigate', (_event, url) => {
    const node = model.nodes.get(uuid);
    if (!node || typeof url !== 'string' || !url) return;
    if (node.url === url) return;
    model.applyOp({ type: 'patch', uuid, patch: { url } });
    persistGraph();
    broadcastGraph();
  });
  wc.on('page-title-updated', (_event, title) => {
    const node = model.nodes.get(uuid);
    if (!node || typeof title !== 'string' || !title || node.title === title) return;
    model.applyOp({ type: 'patch', uuid, patch: { title } });
    persistGraph();
    broadcastGraph();
  });
}

/**
 * Make sure the node has a live WebContentsView: an existing quiet tab wakes
 * through wakeTab (wake generation suppresses redirect history noise), a
 * missing tab is created through createTab. Returns the tabId or null.
 */
function ensureLiveView(runtime, node) {
  const live = liveMap(runtime);
  const existing = live.get(node.uuid);
  if (existing && deps.tabs.has(existing.tabId)) {
    const tab = deps.tabs.get(existing.tabId);
    if (tab && tab.asleep) {
      try { deps.wakeTab(existing.tabId); } catch { /* fall through to bounds */ }
    }
    touchLive(runtime, node.uuid);
    enforceLivePool(runtime);
    return existing.tabId;
  }
  let tabId = null;
  try {
    tabId = deps.createTab(urlForTab(node), { title: node.title || null });
  } catch {
    return null;
  }
  if (tabId == null) return null;
  live.set(node.uuid, { tabId, lastUsedAt: Date.now() });
  tabIdByUuid.set(node.uuid, tabId);
  wireGraphNodeSync(tabId, node.uuid);
  enforceLivePool(runtime);
  return tabId;
}

/* ------------------------------------------------------------------ */
/* resizeNodes — the spatial analog of resizeActiveView                */
/* ------------------------------------------------------------------ */

/**
 * Position every live view of this window. In Mode A the active view sits
 * below BrowserTopBar and right of ZenRail (renderer-reported viewport rect
 * when available, else the derived default); other live views keep their
 * bounds but stay hidden. In Mode B every view is hidden. The z-order guard
 * (DOM overlay open) keeps the active view hidden behind its static backdrop.
 */
function resizeNodes(runtime) {
  if (!runtime || !runtime.window || runtime.window.isDestroyed()) return;
  if (!runtime.spatialChrome) return;
  const layout = sanitizeChromeLayout(runtime.spatialChromeLayout);
  const content = runtime.window.getContentBounds();
  const live = liveMap(runtime);
  const canvas = isCanvasMode(layout.mode) || isCanvasMode(runtime.spatialMode);
  const bounds = canvas
    ? null
    : modeAViewBounds({
      windowWidth: content.width,
      windowHeight: content.height,
      railWidth: layout.railWidth,
      topBarHeight: layout.topBarHeight,
      viewportRect: layout.viewportRect,
    });
  for (const [uuid, entry] of live) {
    const tab = deps.tabs.get(entry.tabId);
    if (!tab) { live.delete(uuid); continue; }
    const isActive = runtime.spatialActiveUuid === uuid;
    const visible = !canvas && bounds != null && isActive
      && !(runtime.spatialGuard === true);
    if (isActive && bounds) deps.presentationView(tab).setBounds(bounds);
    if (deps.liveContents(tab)) deps.setTabViewVisible(tab, visible);
    if (process.env.SPATIAL_DEBUG === '1') {
      const view = deps.presentationView(tab);
      const attached = runtime.window.contentView.children.includes(view);
      console.log('[spatial] resize', JSON.stringify({
        uuid, bounds, visible, canvas, guard: runtime.spatialGuard === true,
        attached, childCount: runtime.window.contentView.children.length,
        asleep: tab.asleep === true, wcAlive: Boolean(deps.liveContents(tab)),
        wcVisible: deps.liveContents(tab)?.isVisible?.(),
      }));
    }
  }
}

/* ------------------------------------------------------------------ */
/* Z-order guard (Mode A)                                              */
/* ------------------------------------------------------------------ */

/**
 * Engaged while a DOM overlay (palette/glance/extensions/shortcuts) covers
 * the viewport in Mode A: capture a crisp frame of the active view, show it
 * as a static backdrop in the spatial document, and hide the live view —
 * native surfaces always paint above DOM, so the backdrop is the only way
 * DOM overlays can appear "over" the page.
 */
async function engageZOrderGuard(runtime) {
  if (!runtime || !runtime.spatialChrome) return;
  if (runtime.spatialMode === 'canvas') return; // views already hidden
  if (runtime.spatialGuard === true) return;
  runtime.spatialGuard = true;
  let dataUrl = null;
  const live = liveMap(runtime);
  const entry = runtime.spatialActiveUuid ? live.get(runtime.spatialActiveUuid) : null;
  const tab = entry ? deps.tabs.get(entry.tabId) : null;
  const wc = tab ? deps.liveContents(tab) : null;
  if (wc) {
    try {
      const image = await wc.capturePage();
      if (image && !image.isEmpty()) dataUrl = image.toDataURL();
      else if (process.env.SPATIAL_DEBUG === '1') {
        console.log('[spatial] guard capture empty', JSON.stringify({
          url: tab.url, visible: tab.view?.getVisible?.() ?? null,
        }));
      }
    } catch (error) {
      if (process.env.SPATIAL_DEBUG === '1') {
        console.log('[spatial] guard capture failed:', error?.message ?? String(error));
      }
      /* a failed capture falls back to the opaque-void backdrop */
    }
  }
  if (tab && deps.liveContents(tab)) deps.setTabViewVisible(tab, false);
  sendToSpatial(runtime, 'spatial:zorder:backdrop', { dataUrl });
}

function releaseZOrderGuard(runtime) {
  if (!runtime || runtime.spatialGuard !== true) return;
  runtime.spatialGuard = false;
  sendToSpatial(runtime, 'spatial:zorder:backdrop', { dataUrl: null });
  resizeNodes(runtime);
}

/** Strip-chrome overlay lifecycle hook (palette/panel/find/spaces). */
function onOverlayChanged() {
  const runtime = deps.rt();
  if (!runtime || !runtime.spatialChrome) return;
  if (runtime.overlayMode) engageZOrderGuard(runtime).catch(() => {});
  else releaseZOrderGuard(runtime);
}

/* ------------------------------------------------------------------ */
/* Mode B (canvas): capture 640×400 WebP per node, hide views          */
/* ------------------------------------------------------------------ */

const sendToSpatial = (runtime, channel, payload) => {
  if (runtime?.window && !runtime.window.isDestroyed()) {
    runtime.window.webContents.send(channel, payload);
  }
};

/**
 * Enter Mode B: capture every live, captureable view (private nodes are the
 * noCapture class and are skipped; a capture is discarded when the tab
 * navigated mid-flight — the navEpoch guard), hand the raw PNG to the
 * renderer for 640×400 WebP transcoding, then hide all views and tell the
 * document to cross-fade to the canvas.
 */
async function enterCanvasMode(runtime) {
  if (!runtime || !runtime.window || runtime.window.isDestroyed()) return;
  runtime.spatialMode = 'canvas';
  const live = liveMap(runtime);
  for (const [uuid, entry] of live) {
    const node = model.nodes.get(uuid);
    const tab = deps.tabs.get(entry.tabId);
    const wc = tab ? deps.liveContents(tab) : null;
    if (!node || !wc) continue;
    if (!shouldCaptureNode(node, tab)) continue;
    const epoch = tab.navEpoch;
    try {
      const image = await wc.capturePage();
      if (!image || image.isEmpty()) continue;
      if (tab.navEpoch !== epoch) continue; // navigated mid-capture
      sendToSpatial(runtime, 'spatial:thumb:capture', {
        uuid,
        png: image.toPNG(),
        width: image.getSize().width,
        height: image.getSize().height,
      });
    } catch { /* skip this node's capture */ }
  }
  resizeNodes(runtime); // canvas mode hides every live view
  sendToSpatial(runtime, 'spatial:mode:changed', { mode: 'canvas' });
}

/** Leave Mode B; wake the clicked node into Mode A when given. */
function exitCanvasMode(runtime, targetUuid = null) {
  runtime.spatialMode = 'reading';
  sendToSpatial(runtime, 'spatial:mode:changed', { mode: 'reading' });
  if (targetUuid) {
    openNode(runtime, targetUuid).catch(() => {});
  } else {
    resizeNodes(runtime);
  }
}

/* ------------------------------------------------------------------ */
/* Node lifecycle                                                      */
/* ------------------------------------------------------------------ */

async function openNode(runtime, uuid) {
  const node = model.nodes.get(uuid);
  if (!node || !runtime?.window) return { ok: false, error: 'missing' };
  runtime.spatialActiveUuid = uuid;
  runtime.spatialMode = 'reading';
  const tabId = ensureLiveView(runtime, node);
  model.applyOp({ type: 'activate', uuid, at: Date.now() });
  if (tabId != null) {
    try { deps.setActiveTab(tabId, { focusContent: true }); } catch { /* bounds below still apply */ }
  }
  resizeNodes(runtime);
  persistGraph();
  // Waking a node ends Mode B (spec: "clicking a node wakes it into Mode
  // A") — the document cross-fades back to the reading chrome.
  sendToSpatial(runtime, 'spatial:mode:changed', { mode: 'reading' });
  sendToSpatial(runtime, 'spatial:active:changed', { uuid });
  return { ok: true, tabId };
}

function closeNode(runtime, uuid) {
  const live = liveMap(runtime);
  const entry = live.get(uuid);
  live.delete(uuid);
  const result = model.applyOp({ type: 'remove', uuid });
  if (entry) {
    try { deps.closeTab(entry.tabId); } catch { /* already closing */ }
    tabIdByUuid.delete(uuid);
  }
  if (runtime.spatialActiveUuid === uuid) {
    runtime.spatialActiveUuid = null;
  }
  persistGraph();
  broadcastGraph();
  resizeNodes(runtime);
  return { ok: result.ok };
}

/** Navigate the active node's tab (wake-then-navigate for quiet tabs). */
function navigateActive(runtime, rawUrl) {
  const uuid = runtime?.spatialActiveUuid;
  if (!uuid) return { ok: false, error: 'missing' };
  const url = rawUrl === NEW_TAB_NODE_URL ? 'blanc://newtab' : rawUrl;
  const node = model.nodes.get(uuid);
  const entry = liveMap(runtime).get(uuid);
  const tabId = entry?.tabId;
  if (node) {
    model.applyOp({ type: 'patch', uuid, patch: { url } });
    persistGraph();
    broadcastGraph();
  }
  if (tabId != null && deps.tabs.has(tabId)) {
    const tab = deps.tabs.get(tabId);
    if (tab && tab.asleep) {
      try { deps.wakeTab(tabId, { navigateTo: url }); return { ok: true }; } catch { /* fall through */ }
    }
    try { deps.loadUrlInTab(tabId, url); return { ok: true }; } catch { /* ignore */ }
  }
  return { ok: false, error: 'no-tab' };
}

/** Renderer acked a transcoded 640×400 WebP data URL for one node. */
function storeThumb(runtime, uuid, dataUrl) {
  const node = model.nodes.get(uuid);
  if (!node || node.private) return;
  node.thumb = dataUrl;
  persistGraph();
  // Re-broadcast lazily: thumbnails arrive one per node right after the mode
  // switch; a full graph broadcast per thumb is fine at ≤ 6 live nodes.
  broadcastGraph();
}

/* ------------------------------------------------------------------ */
/* Session v3 records                                                  */
/* ------------------------------------------------------------------ */

/**
 * The `spatialNodes` column for captureWindowEntry: one record per persisted
 * tab (aligned to the entries order), null when this window carries no
 * spatial records so unstamped windows keep the exact v2 shape.
 */
function windowSpatialNodes(runtime, entries) {
  if (!runtime || !runtime.spatialChrome) return null;
  const tabIds = Array.isArray(entries) ? entries.map((entry) => entry?.id ?? null) : [];
  const records = sessionNodesForTabIds(model, tabIds, tabIdByUuid);
  return records ? { spatialNodes: records } : null;
}

/**
 * Adopt a restored window's `spatialNodes` column: upsert the geometry into
 * the graph and bind each saved uuid to its freshly created tab id
 * (`restoredIds` is aligned with the saved urls exactly like splitIds).
 */
function adoptRestoredWindow(runtime, saved, restoredIds) {
  if (!runtime || !saved || !Array.isArray(restoredIds)) return;
  const records = parseSessionNodes(saved.spatialNodes);
  records.forEach((record, index) => {
    if (!record) return;
    const tabId = restoredIds[index] ?? null;
    const existing = model.nodes.get(record.uuid);
    if (existing) {
      Object.assign(existing, {
        x: record.x, y: record.y, w: record.w, h: record.h,
        parentUuid: record.parentUuid, edges: record.edges,
      });
    } else {
      const node = normalizeNode({
        uuid: record.uuid,
        url: saved.urls?.[index] ?? 'https://new-tab.spatial/local',
        title: saved.meta?.[index]?.title ?? '',
        x: record.x, y: record.y, w: record.w, h: record.h,
        parentUuid: record.parentUuid,
        edges: record.edges,
      });
      if (node) model.nodes.set(node.uuid, node);
    }
    if (tabId != null) tabIdByUuid.set(record.uuid, tabId);
    // Restored tabs are born asleep (lazy restore): they wake on openNode.
    if (tabId != null) liveMap(runtime).set(record.uuid, { tabId, lastUsedAt: 0 });
  });
  // Re-parent edges whose parents were dropped from the saved column.
  for (const node of model.nodes.values()) {
    if (node.parentUuid && !model.nodes.has(node.parentUuid)) node.parentUuid = null;
    node.edges = node.edges.filter((uuid) => model.nodes.has(uuid));
  }
  persistGraph();
}

/* ------------------------------------------------------------------ */
/* IPC registration                                                    */
/* ------------------------------------------------------------------ */

function registerGraphIpc() {
  const ipc = createGraphIpc({
    chromeHandle: deps.chromeHandle,
    chromeOn: deps.chromeOn,
    handlers: {
      load: () => ({ ok: true, graph: serializeGraph() }),
      mutate: (ops) => {
        const runtime = deps.rt();
        const result = model.applyOps(ops);
        if (result.ok) {
          persistGraph();
          broadcastGraph();
          if (runtime) resizeNodes(runtime);
        }
        return result;
      },
      openNode: (uuid) => openNode(deps.rt(), uuid),
      closeNode: (uuid) => closeNode(deps.rt(), uuid),
      navigate: (url) => navigateActive(deps.rt(), url),
      setMode: (mode) => {
        const runtime = deps.rt();
        if (!runtime || !runtime.spatialChrome) return { ok: false, error: 'no-runtime' };
        if (mode === 'canvas') enterCanvasMode(runtime).catch(() => {});
        else exitCanvasMode(runtime, null);
        return { ok: true, mode };
      },
      setChromeLayout: (layout) => {
        const runtime = deps.rt();
        if (!runtime) return;
        runtime.spatialChromeLayout = layout;
        runtime.spatialMode = layout.mode === 'canvas' ? 'canvas' : runtime.spatialMode;
        resizeNodes(runtime);
      },
      engageGuard: () => engageZOrderGuard(deps.rt()).catch(() => {}),
      releaseGuard: () => releaseZOrderGuard(deps.rt()),
      storeThumb: ({ uuid, dataUrl }) => storeThumb(deps.rt(), uuid, dataUrl),
    },
  });
  ipc.register();
}

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

/**
 * Wire the spatial runtime into main.js. Called once from
 * registerIpcHandlers() with main's own (trust-gated) registrars and tab
 * model — thin hooks only; nothing here restructures Blanc.
 */
// Fresh-State Browser Law (master spec §0.2): a first run opens ONE clean
// New Tab node at (0, 0) in reading mode — 0 edges, 0 regions, 0 notes.
// Deterministic uuid, so restarts keep the same identity.
const FIRST_RUN_NODE = Object.freeze({
  uuid: '00000000-0000-4000-8000-000000000001',
  url: 'https://new-tab.spatial/local',
  title: 'New Tab',
  x: 0,
  y: 0,
});

function ensureFirstRunSeed() {
  if (model.nodes.size > 0) return;
  const node = normalizeNode({
    ...FIRST_RUN_NODE,
    w: 0,
    h: 0,
    parentUuid: null,
    edges: [],
    mode: 'reading',
    lastActiveAt: Date.now(),
  });
  if (!node) return;
  model.nodes.set(node.uuid, node);
  persistGraph();
}

function initSpatial(injected) {
  deps = injected;
  store = new JsonStore('spatial-graph', { version: 1, nodes: [] }, { scope: 'device', quietErrors: true });
  const saved = store.data && Array.isArray(store.data.nodes) ? store.data.nodes : [];
  model = createGraphModel(saved);
  // Rebind persisted nodes to no tabs: tab ids are process-local.
  for (const node of model.nodes.values()) node.lastActiveAt = node.lastActiveAt ?? 0;
  ensureFirstRunSeed();
  registerGraphIpc();
}

module.exports = {
  CHROME_SPATIAL_URL,
  spatialChromeEnabled,
  spatialPreloadPath,
  initSpatial,
  resizeNodes,
  onOverlayChanged,
  engageZOrderGuard,
  releaseZOrderGuard,
  enterCanvasMode,
  exitCanvasMode,
  openNode,
  closeNode,
  adoptRestoredWindow,
  windowSpatialNodes,
  serializeGraph,
};
