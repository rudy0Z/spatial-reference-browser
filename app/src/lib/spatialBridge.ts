/**
 * app/src/lib/spatialBridge.ts — renderer side of the Spatial shell bridge
 * (Phase 3, spec steps 2–3).
 *
 * When the app document runs as blanc-chrome://spatial/ inside the Spatial
 * browser, `window.spatialAPI` (spatial-preload.js) is present and the MAIN
 * process owns the node graph. The bridge then:
 *   - hydrates useGraphStore from the main-process graph (fresh state stays
 *     clean — no local first-run seed; the store is a view of main's graph),
 *   - pushes store mutations to main as graph ops (moves, adds, activation),
 *   - pushes mode changes (Cmd/Ctrl+Space ⇄ toggleCanvas) and the chrome
 *     layout (rail width, top-bar height) so main can place live
 *     WebContentsViews below BrowserTopBar and right of ZenRail,
 *   - engages the z-order guard while a DOM overlay (palette / glance /
 *     extensions / shortcuts) covers a live view in Mode A,
 *   - transcodes main's raw PNG page captures into 640×400 WebP thumbnails.
 *
 * Without `window.spatialAPI` (vite dev server, benchmark harness) it is a
 * no-op and the prototype keeps its local-store behavior.
 */
import { domainOf, urlHashOf } from './types'
import { useGraphStore } from '../store/useGraphStore'
import type { EdgeId, GraphEdgeRecord, NodeUuid, SpatialTabNodeRecord } from './types'

export type SpatialNodeRecord = {
  uuid: string
  url: string
  title: string
  x: number
  y: number
  w: number
  h: number
  parentUuid: string | null
  edges: string[]
  mode: 'reading' | 'canvas'
  pinned: boolean
  private: boolean
  thumb: string | null
  lastActiveAt: number
}

export type SpatialGraphPayload = { version: number; nodes: SpatialNodeRecord[] }

type SpatialAPI = {
  load: () => Promise<{ ok: boolean; graph: SpatialGraphPayload }>
  mutate: (ops: unknown[]) => Promise<{ ok: boolean; reason?: string }>
  openNode: (uuid: string) => Promise<{ ok: boolean; tabId?: number | null }>
  closeNode: (uuid: string) => Promise<{ ok: boolean }>
  navigate: (url: string) => Promise<{ ok: boolean }>
  setMode: (mode: 'reading' | 'canvas') => Promise<{ ok: boolean }>
  setChromeLayout: (layout: {
    topBarHeight: number
    railWidth: number
    mode: 'reading' | 'canvas'
  }) => void
  zorderEngage: () => void
  zorderRelease: () => void
  storeThumb: (uuid: string, dataUrl: string) => void
  win: { minimize: () => void; maximize: () => void; close: () => void }
  onGraphUpdated: (cb: (graph: SpatialGraphPayload) => void) => () => void
  onZorderBackdrop: (cb: (payload: { dataUrl: string | null }) => void) => () => void
  onModeChanged: (cb: (payload: { mode: 'reading' | 'canvas' }) => void) => () => void
  onActiveChanged: (cb: (payload: { uuid: string }) => void) => () => void
  onThumbCapture: (
    cb: (payload: { uuid: string; png: Uint8Array; width: number; height: number }) => void,
  ) => () => void
}

declare global {
  interface Window {
    spatialAPI?: SpatialAPI
  }
}

export const spatialApi: SpatialAPI | null = window.spatialAPI ?? null
/** True when this document is the real browser's spatial chrome. */
export const spatialEnabled = spatialApi != null

const PUSH_DEBOUNCE_MS = 120

type GraphOp =
  | { type: 'add'; node: Record<string, unknown> }
  | { type: 'move'; uuid: string; x: number; y: number }
  | { type: 'patch'; uuid: string; patch: { title?: string; url?: string; pinned?: boolean } }
  | { type: 'remove'; uuid: string }
  | { type: 'connect'; parentUuid: string; childUuid: string }
  | { type: 'activate'; uuid: string; at: number }

/** Full store record for a node that only exists in main's graph. */
function makeStoreRecord(main: SpatialNodeRecord, now: number): SpatialTabNodeRecord {
  return {
    uuid: main.uuid as NodeUuid,
    urlHash: urlHashOf(main.url),
    url: main.url,
    domain: domainOf(main.url),
    title: main.title || domainOf(main.url),
    regionId: null,
    nodeType: 'tab',
    ramState: 'hibernated',
    ramMb: 0,
    isAudible: false,
    isPinned: main.pinned,
    isLoading: false,
    noCapture: main.private,
    ephemeral: false,
    viaAuth: false,
    searchQuery: null,
    subPages: [],
    excerpt: null,
    keywords: Array.from(new Set([domainOf(main.url)])).slice(0, 8),
    parentUuid: (main.parentUuid as NodeUuid | null) ?? null,
    ghostOfUuid: null,
    ghostTetherUuid: null,
    ghostMatch: null,
    settled: true,
    visitCount: 1,
    lastVisitedAt: main.lastActiveAt || now,
    createdAt: now,
    x: main.x,
    y: main.y,
    fx: null,
    fy: null,
  }
}

/** Store edges for one main node's parent/child relations. */
function edgesForMain(main: SpatialNodeRecord, now: number): Record<EdgeId, GraphEdgeRecord> {
  const edges: Record<EdgeId, GraphEdgeRecord> = {}
  if (main.parentUuid) {
    const id = `${main.parentUuid}->${main.uuid}` as EdgeId
    edges[id] = { id, source: main.parentUuid as NodeUuid, target: main.uuid as NodeUuid, weight: 1, kind: 'spawn', createdAt: now }
  }
  for (const child of main.edges) {
    const id = `${main.uuid}->${child}` as EdgeId
    edges[id] = { id, source: main.uuid as NodeUuid, target: child as NodeUuid, weight: 1, kind: 'spawn', createdAt: now }
  }
  return edges
}

let lastSyncedPositions = new Map<NodeUuid, { x: number; y: number }>()
let pushTimer: ReturnType<typeof setTimeout> | null = null
let applyingRemote = false
let shellOverlaysOpen = false
let thumbCanvas: HTMLCanvasElement | null = null

/** Queue a diff push (store → main): moves first, then structural adds. */
function schedulePush() {
  if (!spatialApi || applyingRemote) return
  if (pushTimer) return
  pushTimer = setTimeout(() => {
    pushTimer = null
    pushDiff()
  }, PUSH_DEBOUNCE_MS)
}

function pushDiff() {
  if (!spatialApi) return
  const state = useGraphStore.getState()
  const ops: GraphOp[] = []
  const now = Date.now()
  for (const node of Object.values(state.nodes)) {
    if (node.nodeType === 'ghost-echo') continue // store-local suggestion
    const last = lastSyncedPositions.get(node.uuid)
    if (!last) {
      ops.push({
        type: 'add',
        node: {
          uuid: node.uuid,
          url: node.url,
          title: node.title,
          x: Math.round(node.x),
          y: Math.round(node.y),
          w: 0,
          h: 0,
          parentUuid: node.parentUuid,
          edges: [],
          pinned: node.isPinned,
          private: node.noCapture,
        },
      })
      lastSyncedPositions.set(node.uuid, { x: Math.round(node.x), y: Math.round(node.y) })
      continue
    }
    const x = Math.round(node.x)
    const y = Math.round(node.y)
    if (last.x !== x || last.y !== y) {
      ops.push({ type: 'move', uuid: node.uuid, x, y })
      lastSyncedPositions.set(node.uuid, { x, y })
    }
  }
  for (const uuid of lastSyncedPositions.keys()) {
    if (!state.nodes[uuid] && uuid !== '') {
      ops.push({ type: 'remove', uuid })
      lastSyncedPositions.delete(uuid)
    }
  }
  void now
  if (ops.length) void spatialApi.mutate(ops)
}

/** Apply one main-graph payload to the store (main is authoritative). */
function applyGraphToStore(graph: SpatialGraphPayload) {
  if (!graph || typeof graph !== 'object' || !Array.isArray(graph.nodes)) return
  applyingRemote = true
  try {
    const state = useGraphStore.getState()
    const now = Date.now()
    const nextNodes: Record<NodeUuid, SpatialTabNodeRecord> = { ...state.nodes }
    const nextEdges: Record<EdgeId, GraphEdgeRecord> = { ...state.edges }
    const seen = new Set<NodeUuid>()
    for (const main of graph.nodes) {
      if (!main?.uuid) continue
      seen.add(main.uuid)
      const existing = nextNodes[main.uuid]
      if (existing) {
        nextNodes[main.uuid] = {
          ...existing,
          url: main.url,
          title: main.title || existing.title,
          x: main.x,
          y: main.y,
          isPinned: main.pinned,
          noCapture: main.private,
        }
      } else {
        nextNodes[main.uuid] = makeStoreRecord(main, now)
      }
      Object.assign(nextEdges, edgesForMain(main, now))
      if (main.thumb) {
        // Thumbnails ride on the graph payload; the store's preview stays
        // renderer-local, so expose the webp via excerpt-free fields only.
        // RichCard reads `preview` — keep the thumbnail for the Phase-3
        // surface through the store's runtime field set.
        (nextNodes[main.uuid] as SpatialTabNodeRecord & { spatialThumb?: string }).spatialThumb = main.thumb
      }
    }
    for (const uuid of Object.keys(nextNodes)) {
      const node = nextNodes[uuid]
      if (node.nodeType === 'ghost-echo') continue
      if (!seen.has(uuid as NodeUuid)) {
        delete nextNodes[uuid]
        delete nextEdges[`${node.parentUuid}->${uuid}` as EdgeId]
      }
    }
    lastSyncedPositions = new Map(
      Object.values(nextNodes)
        .filter((node) => node.nodeType !== 'ghost-echo')
        .map((node) => [node.uuid, { x: Math.round(node.x), y: Math.round(node.y) }]),
    )
    useGraphStore.setState({ nodes: nextNodes, edges: nextEdges, hasHydrated: true })
  } finally {
    applyingRemote = false
  }
}

/** 640×400 WebP transcode of main's raw PNG capture (spec Mode B size). */
async function transcodeThumb(uuid: string, png: Uint8Array): Promise<void> {
  if (!spatialApi) return
  try {
    const blob = new Blob([png.slice().buffer as ArrayBuffer], { type: 'image/png' })
    const bitmap = await createImageBitmap(blob)
    thumbCanvas ??= document.createElement('canvas')
    thumbCanvas.width = 640
    thumbCanvas.height = 400
    const ctx = thumbCanvas.getContext('2d')
    if (!ctx) return
    // Cover-fit: fill the 640×400 frame, centre-cropped.
    const scale = Math.max(640 / bitmap.width, 400 / bitmap.height)
    const w = bitmap.width * scale
    const h = bitmap.height * scale
    ctx.drawImage(bitmap, (640 - w) / 2, (400 - h) / 2, w, h)
    const webp = thumbCanvas.toDataURL('image/webp', 0.8)
    // Chromium emits `data:image/webp;base64,…` (sometimes with a quality
    // parameter) — accept the image/webp family.
    if (webp.startsWith('data:image/webp')) spatialApi.storeThumb(uuid, webp)
    bitmap.close()
  } catch {
    // A failed transcode simply leaves the node without a fresh thumbnail.
  }
}

/** Report the chrome geometry so main can place live views. */
let layoutOverride = { railWidth: 224, topBarHeight: 48 }
function reportLayout() {
  if (!spatialApi) return
  const store = useGraphStore.getState()
  spatialApi.setChromeLayout({
    topBarHeight: layoutOverride.topBarHeight,
    railWidth: layoutOverride.railWidth,
    mode: store.viewMode === 'canvas' ? 'canvas' : 'reading',
  })
}

/**
 * Install the bridge. Returns an unsubscribe function (and a small handle
 * for the shell overlay flags App owns locally).
 */
export function initSpatialBridge(): {
  setShellOverlaysOpen: (open: boolean) => void
  setRailWidth: (width: number) => void
  dispose: () => void
} | null {
  if (!spatialApi) return null
  const unsubs: Array<() => void> = []

  // 1. Hydrate from main, then subscribe to graph broadcasts.
  void spatialApi.load().then((result) => {
    if (result?.ok && result.graph) applyGraphToStore(result.graph)
    reportLayout()
  })
  unsubs.push(spatialApi.onGraphUpdated((graph) => {
    applyGraphToStore(graph)
    schedulePush()
  }))

  // 2. Store → main: structural/move diffs.
  let previousStore = useGraphStore.getState()
  const unsubscribeStore = useGraphStore.subscribe((state) => {
    // Node geometry/structure changed → schedule a diff push.
    schedulePush()
    // Active node changed → open it in the real browser (Mode A wake).
    if (state.activeNodeUuid !== previousStore.activeNodeUuid && state.activeNodeUuid) {
      void spatialApi?.openNode(state.activeNodeUuid)
      spatialApi?.mutate([{ type: 'activate', uuid: state.activeNodeUuid, at: Date.now() }])
    }
    // Mode changed (Cmd/Ctrl+Space in the prototype key handler) → main.
    if (state.viewMode !== previousStore.viewMode && spatialApi) {
      void spatialApi.setMode(state.viewMode === 'canvas' ? 'canvas' : 'reading')
      reportLayout()
    }
    previousStore = state
  })
  unsubs.push(unsubscribeStore)

  // 3. Main → store: mode changes and active-node changes.
  unsubs.push(spatialApi.onModeChanged(({ mode }) => {
    const state = useGraphStore.getState()
    const next = mode === 'canvas' ? 'canvas' : 'reading'
    if (state.viewMode !== next) useGraphStore.getState().setViewMode(next)
  }))
  unsubs.push(spatialApi.onActiveChanged(({ uuid }) => {
    const state = useGraphStore.getState()
    if (state.activeNodeUuid !== uuid && state.nodes[uuid]) {
      useGraphStore.setState({ activeNodeUuid: uuid })
    }
  }))

  // 4. Mode B thumbnail pipeline: PNG in, 640×400 WebP out.
  unsubs.push(spatialApi.onThumbCapture(({ uuid, png }) => {
    void transcodeThumb(uuid, png)
  }))

  // 5. Z-order backdrop: main captured the live view and hid it; the crisp
  // static frame paints over the viewport area (right of the rail, below the
  // top bar — exactly where the native view sat) until release. A plain DOM
  // element, managed here so no component has to know about it.
  let backdropEl: HTMLImageElement | null = null
  const ensureBackdropEl = () => {
    if (!backdropEl) {
      backdropEl = document.createElement('img')
      backdropEl.id = 'spatial-zorder-backdrop'
      backdropEl.alt = ''
      backdropEl.setAttribute('aria-hidden', 'true')
      backdropEl.style.cssText
        = 'position:fixed;top:48px;left:0;width:100vw;height:calc(100vh - 48px);'
        + 'object-fit:cover;background:var(--bg-void,#0B0B0D);display:none;'
        + 'z-index:35;pointer-events:none;'
      document.body.appendChild(backdropEl)
    }
    backdropEl.style.left = `${layoutOverride.railWidth}px`
    backdropEl.style.top = `${layoutOverride.topBarHeight}px`
    backdropEl.style.width = `calc(100vw - ${layoutOverride.railWidth}px)`
    backdropEl.style.height = `calc(100vh - ${layoutOverride.topBarHeight}px)`
    return backdropEl
  }
  unsubs.push(spatialApi.onZorderBackdrop(({ dataUrl }) => {
    const el = ensureBackdropEl()
    if (dataUrl) {
      el.src = dataUrl
      el.style.display = 'block'
    } else {
      // No capturable frame (occluded/degenerate compositor): show the opaque
      // void instead. Fail-safe over showing DOM beneath a native view.
      el.removeAttribute('src')
      el.style.display = 'block'
    }
  }))

  // 6. Guard engagement: while any DOM overlay covers the viewport in Mode A
  // (palette/glance/extensions/shortcuts), engage (main captures + hides the
  // view; §5 renders the static backdrop) and release when all are closed.
  // Mode B keeps views hidden anyway.
  const syncGuard = () => {
    if (!spatialApi) return
    const state = useGraphStore.getState()
    const reading = state.viewMode === 'reading'
    const covered = reading
      && (state.paletteOpen || state.glanceOpen || shellOverlaysOpen)
    if (covered) spatialApi.zorderEngage()
    else spatialApi.zorderRelease()
  }
  const unsubscribeGuard = useGraphStore.subscribe((state) => {
    if (state.paletteOpen !== previousStore.paletteOpen
      || state.glanceOpen !== previousStore.glanceOpen
      || state.viewMode !== previousStore.viewMode) {
      syncGuard()
    }
    previousStore = state
  })
  unsubs.push(unsubscribeGuard)

  // 7. Layout reporting on resize (rail/top bar are DOM-owned).
  window.addEventListener('resize', reportLayout)
  unsubs.push(() => window.removeEventListener('resize', reportLayout))

  return {
    setShellOverlaysOpen(open: boolean) {
      shellOverlaysOpen = open
      syncGuard()
    },
    /** ZenRail width (224 open / 0 collapsed) — App owns the toggle. */
    setRailWidth(width: number) {
      layoutOverride.railWidth = Number.isFinite(width) ? Math.max(0, width) : 0
      reportLayout()
    },
    dispose() {
      for (const off of unsubs) off()
    },
  }
}
