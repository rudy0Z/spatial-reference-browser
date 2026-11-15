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
const { randomUUID } = require('node:crypto');

const { JsonStore } = require('../store');
const { CHROME_SPATIAL_URL } = require('../chrome-protocol');
const {
  createGraphModel,
  normalizeNode,
  parseSessionNodes,
  sessionNodesForTabIds,
  pickEvictionCandidate,
  MAX_LIVE_VIEWS,
  UUID_PATTERN,
  shouldCaptureNode,
} = require('./node-model');
const { modeAViewBounds, sanitizeChromeLayout, isCanvasMode } = require('./canvas-layout');
const {
  classifyChildBranch,
  shouldCollapseBranch,
  childBranchPosition,
} = require('./branch-policy');
const {
  collectHibernationScript,
  normalizeHibernationState,
  restoreHibernationScript,
  nextAudioImmunity,
} = require('./hibernation-state');
const { createGraphIpc } = require('./graph-ipc');

// uuid → live tab id. Tab ids are process-local; entries for dead tabs are
// pruned lazily and never persist (the session column carries uuids only).
const tabIdByUuid = new Map();

// uuid → { scrollX, scrollY, mediaTime, excerpt, at } captured right before
// the warm pool discarded the renderer. Runtime-scoped: after a full restart
// Blanc's own navigationHistory pageState carries the scroll back instead.
const hibernationByUuid = new Map();

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
  const immune = audioImmunityMap(runtime);
  const now = Date.now();
  const entries = [];
  for (const [uuid, entry] of live) {
    const tab = deps.tabs.get(entry.tabId);
    if (!tab) { live.delete(uuid); continue; }
    entries.push({
      uuid,
      tabId: entry.tabId,
      lastUsedAt: entry.lastUsedAt ?? 0,
      isActive: runtime.spatialActiveUuid === uuid,
      // tab.audible is Blanc's own field; the 2.5 s debounce window (below)
      // covers the brief-pause case the spec calls out.
      isAudible: tab.audible === true || (immune.get(uuid) ?? 0) > now,
    });
  }
  return entries;
}

/** Per-window audio-immunity deadlines (uuid → until-ms), 2.5 s debounce. */
function audioImmunityMap(runtime) {
  if (!runtime.spatialAudioImmune) runtime.spatialAudioImmune = new Map();
  return runtime.spatialAudioImmune;
}

/** The uuid a tab id is bound to, or null (small maps — a scan is fine). */
function uuidForTabId(tabId) {
  if (tabId == null) return null;
  for (const [uuid, bound] of tabIdByUuid) {
    if (bound === tabId) return uuid;
  }
  return null;
}

/**
 * Audio-state-changed relay (tab-view.js): every transition renews the tab's
 * 2.5 s eviction immunity so a brief media pause never hands an active
 * video/audio tab to the evictor (spec Phase 3 step 2).
 */
function noteSpatialAudioActivity(runtime, tabId) {
  if (!runtime || !runtime.spatialChrome) return;
  const uuid = uuidForTabId(tabId);
  if (!uuid) return;
  const immune = audioImmunityMap(runtime);
  immune.set(uuid, nextAudioImmunity(Date.now()));
  // Bound the map: one entry per live node at most, but a stale uuid whose
  // tab died lingers — prune entries with no live binding while we are here.
  if (immune.size > liveMap(runtime).size + 16) {
    for (const key of immune.keys()) {
      if (!liveMap(runtime).has(key)) immune.delete(key);
    }
  }
}

/** Touch the LRU clock for a node's live view. */
function touchLive(runtime, uuid) {
  const live = liveMap(runtime);
  const entry = live.get(uuid);
  if (entry) entry.lastUsedAt = Date.now();
}

/**
 * True 0 MB hibernation, half one: BEFORE the renderer is discarded, ask the
 * page for { scrollX, scrollY, mediaTime, excerpt } (hibernation-state.js).
 * A private node keeps no excerpt (the noCapture class); a broken renderer
 * answer simply leaves no record and wake falls back to Blanc's own
 * navigationHistory pageState restore.
 */
async function collectHibernation(runtime, uuid, entry) {
  const node = model.nodes.get(uuid);
  const tab = deps.tabs.get(entry?.tabId);
  const wc = tab ? deps.liveContents(tab) : null;
  if (!node || !wc) return;
  try {
    const raw = await wc.executeJavaScript(collectHibernationScript(), true);
    const state = normalizeHibernationState(raw, { private: node.private === true });
    if (state) hibernationByUuid.set(uuid, state);
  } catch { /* renderer gone mid-collect — pageState covers wake */ }
}

/**
 * True 0 MB hibernation, half two: the woken view shows its cached WebP
 * cover instantly (the shell paints node.thumb while the view loads) and the
 * recorded scroll/media position is restored on the finished load. One-shot:
 * the record is dropped whether or not the restore succeeded.
 */
async function restoreHibernation(tabId, uuid) {
  const state = hibernationByUuid.get(uuid);
  if (!state) return;
  hibernationByUuid.delete(uuid);
  const tab = deps.tabs.get(tabId);
  const wc = tab ? deps.liveContents(tab) : null;
  if (!tab || !wc) return;
  const epochAtWake = tab.navEpoch;
  try {
    // wakeTab's promise resolves after its first load, but the retained-view
    // path can still be reloading — give did-finish-load a bounded chance.
    if (wc.isLoading()) {
      await new Promise((resolve) => {
        const done = () => { wc.removeListener('did-finish-load', done); resolve(); };
        wc.once('did-finish-load', done);
        setTimeout(done, 4000).unref?.();
      });
    }
    if (tab.navEpoch !== epochAtWake) return; // navigated mid-restore
    await wc.executeJavaScript(restoreHibernationScript(state), true);
  } catch { /* a failed restore is cosmetic; the page is already usable */ }
}

/**
 * Enforce the ≤ 6 live-view pool by quieting the LRU candidate through
 * Blanc's own sleepTab (renderer discarded, ~148 MB reclaimed, snapshot kept
 * for wake). The active node and pinned/audible/private nodes are immune.
 * Async: the hibernation record is collected from the page before the
 * renderer dies. Callers fire-and-forget; this never rejects.
 */
async function enforceLivePool(runtime) {
  const evictUuid = pickEvictionCandidate(liveEntries(runtime), model, { maxLive: MAX_LIVE_VIEWS });
  if (!evictUuid) return;
  const live = liveMap(runtime);
  const entry = live.get(evictUuid);
  live.delete(evictUuid);
  if (entry) {
    await collectHibernation(runtime, evictUuid, entry);
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
      try {
        // Wake, then restore the hibernation record (scroll/media) once the
        // load has finished. The cached WebP cover is already on the node —
        // the shell paints it while this view loads.
        void Promise.resolve(deps.wakeTab(existing.tabId))
          .then((woke) => { if (woke) return restoreHibernation(existing.tabId, node.uuid); })
          .catch(() => { /* bounds below still apply */ });
      } catch { /* fall through to bounds */ }
    }
    touchLive(runtime, node.uuid);
    void enforceLivePool(runtime).catch(() => {});
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
  void enforceLivePool(runtime).catch(() => {});
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
  // `released: true` disambiguates "guard off" from "guard on, capture
  // failed" — both carry dataUrl:null, but only the first may hide the
  // backdrop element (the fail-safe void must stay up while the guard holds).
  sendToSpatial(runtime, 'spatial:zorder:backdrop', { dataUrl: null, released: true });
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
  hibernationByUuid.delete(uuid);
  if (runtime.spatialActiveUuid === uuid) {
    runtime.spatialActiveUuid = null;
  }
  persistGraph();
  broadcastGraph();
  resizeNodes(runtime);
  return { ok: result.ok };
}

/**
 * The shell's canvas delete arrives as a `remove` op through graph:mutate —
 * the graph is the tab list for the spatial window, so each removed node's
 * tab closes too (closeNode semantics, resolved through the owning runtime).
 */
function closeTabsForRemovedOps(ops) {
  for (const op of (Array.isArray(ops) ? ops : [])) {
    if (!op || op.type !== 'remove' || !(typeof op.uuid === 'string' && UUID_PATTERN.test(op.uuid))) continue;
    const tabId = tabIdByUuid.get(op.uuid);
    if (tabId != null) {
      const owner = deps.runtimeForTab?.(tabId) ?? null;
      if (owner) {
        const live = liveMap(owner);
        live.delete(op.uuid);
      }
      try { deps.closeTab(tabId); } catch { /* already closing */ }
      tabIdByUuid.delete(op.uuid);
    }
    hibernationByUuid.delete(op.uuid);
  }
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

/* ------------------------------------------------------------------ */
/* Link branching (spec Phase 3 step 3)                                */
/* ------------------------------------------------------------------ */

// Spawned child nodes carry the Mode B card footprint (640×400) — the size
// every RichCard renders, and the capture size their thumbnails use.
const BRANCH_NODE_SIZE = Object.freeze({ w: 640, h: 400 });

/**
 * A page-opened child tab (tab-view.js setWindowOpenHandler → deps
 * .onSpatialBranch) becomes a child NODE on the graph with a parentUuid
 * edge — but only when the person actually asked for the branch: main gates
 * on the spatial-link-preload activation (Cmd/Ctrl+Click, middle-click,
 * target="_blank"), so a script's window.open stays an ordinary tab ("the
 * system pays, the user confirms"). Classification and chain collapse are
 * branch-policy.js's pure decisions:
 *   fork     — fresh main-process tab → child node beside its parent;
 *   via-auth — OAuth/SSO/payment branch → ONE viaAuth node per parent,
 *              hops inside REDIRECT_COLLAPSE_MS patch that node's url;
 *   refuse   — a POST body or a non-navigable target → no node at all.
 */
function handleSpatialBranch(runtime, parentTabId, childTabId, info = {}) {
  if (!runtime || !runtime.spatialChrome) return { ok: false, reason: 'no-spatial' };
  const parentUuid = uuidForTabId(parentTabId);
  const parent = parentUuid ? model.nodes.get(parentUuid) : null;
  if (!parent) return { ok: false, reason: 'no-parent' };
  if (info.userRequested !== true) return { ok: true, action: 'skipped-unrequested' };
  const at = Date.now();
  const classified = classifyChildBranch({
    url: info.url,
    postBody: info.postBody ?? null,
    disposition: typeof info.disposition === 'string' ? info.disposition : '',
    chromiumBuilt: info.chromiumBuilt === true,
  });
  if (classified === 'refuse') return { ok: true, action: 'refused' };
  if (classified === 'via-auth') {
    // Collapse into the parent's ONE viaAuth node while the chain window is
    // open (auth providers hop across their own subdomains).
    for (const childUuid of parent.edges) {
      const child = model.nodes.get(childUuid);
      if (child && child.viaAuth && shouldCollapseBranch(child, { url: info.url, at })) {
        model.applyOp({ type: 'patch', uuid: child.uuid, patch: { url: info.url } });
        persistGraph();
        broadcastGraph();
        return { ok: true, action: 'collapsed', uuid: child.uuid };
      }
    }
  }
  const position = childBranchPosition(parent, parent.edges.length);
  const node = normalizeNode({
    uuid: randomUUID(),
    url: info.url,
    title: '',
    x: position.x,
    y: position.y,
    w: BRANCH_NODE_SIZE.w,
    h: BRANCH_NODE_SIZE.h,
    parentUuid: parent.uuid,
    edges: [],
    mode: 'reading',
    pinned: false,
    // The child inherits the opener's privacy — createTab was called with
    // `private: tab.private` in tab-view.js, so the graph matches the tab.
    private: parent.private === true,
    branchKind: classified === 'via-auth' ? 'auth' : 'link',
    viaAuth: classified === 'via-auth',
    createdAt: at,
    lastActiveAt: at,
  });
  if (!node) return { ok: false, reason: 'node' };
  const added = model.applyOp({ type: 'add', node: { ...node, edges: [] } });
  if (!added.ok) return { ok: false, reason: added.reason };
  // Bind the already-created child tab to its node and register it in this
  // window's live pool — the pool may immediately quiet the LRU in reply.
  if (childTabId != null) {
    tabIdByUuid.set(node.uuid, childTabId);
    liveMap(runtime).set(node.uuid, { tabId: childTabId, lastUsedAt: at });
    wireGraphNodeSync(childTabId, node.uuid);
    void enforceLivePool(runtime).catch(() => {});
  }
  persistGraph();
  broadcastGraph();
  // A foreground branch is where the person is reading now — Blanc's
  // showOpenedTab already displayed it; keep the shell's active marker in
  // lockstep. A background (Cmd+Click) branch stays where it was.
  if (info.disposition !== 'background-tab') {
    runtime.spatialActiveUuid = node.uuid;
    sendToSpatial(runtime, 'spatial:active:changed', { uuid: node.uuid });
    resizeNodes(runtime);
  }
  return {
    ok: true,
    action: classified === 'via-auth' ? 'spawned-auth' : 'spawned',
    uuid: node.uuid,
  };
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
          closeTabsForRemovedOps(ops);
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
  handleSpatialBranch,
  noteSpatialAudioActivity,
  adoptRestoredWindow,
  windowSpatialNodes,
  serializeGraph,
};
