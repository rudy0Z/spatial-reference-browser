/**
 * app/src/store/useGraphStore.ts — zustand + persist store for the spatial
 * graph (SPEC §1, §4, §5, §6, §7).
 *
 * Model: `node_uuid` (unique instance) vs `url_hash` (canonical, shared by
 * duplicates; sticky notes attach to it — §7.6). LRU live pool of 5 with
 * audible / pinned / recording immunity (§5.2, §5.3, §7.7). Ghost Echo
 * matcher: relevance = 0.55·cosine + 0.30·normalizedCoVisitation +
 * 0.15·recencyDecay, threshold 0.78 (§6). Macro-stack collapse/fan (§4.5).
 * Palette actions incl. /seed-700 → 700 designer nodes across 7 clusters (§5.4).
 *
 * Persisted: nodes, edges, regions, notes, voice memos (audio as data URLs
 * — §8), coordinates, active node, collapse stacks, seededVersion, viewMode.
 * Runtime-only: palette/glance flags, freeze/override toggles, zoom,
 * recording node, workbench MRU, eviction notice, suppressed ghost hashes.
 *
 * Phase 1.5: `/seed-700` replaces the world with 700 designer reference
 * nodes across 7 clusters; `tidyToMoodboard(regionId)` snaps a region onto
 * the contact-sheet grid (pure math in `lib/moodboard.ts`'s
 * `computeMoodboardGrid` — positions only, so every graph edge survives).
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { PersistStorage, StorageValue } from 'zustand/middleware'
import { cosineSimilarity, embedText, tokenize } from '../lib/embed'
import { enforceLivePool, isNodeImmune } from '../lib/livePool'
import { computeMoodboardGrid } from '../lib/moodboard'
import {
  buildCleanFirstRunState,
  buildStressSeed700,
  FIRST_RUN_SEED_VERSION,
  STRESS_SEED_VERSION,
} from '../lib/seed'
import {
  COLD_ARCHIVE_DAYS,
  REGION_COLORS,
  daysSince,
  domainOf,
  isColdArchive,
  lodForZoom,
  looksLikeAuthOrPaymentUrl,
  ramMbFor,
  urlHashOf,
} from '../lib/types'
import type {
  EdgeId,
  EvictionNotice,
  GhostEchoCandidate,
  GhostEchoScoreBreakdown,
  GraphEdgeRecord,
  MemoId,
  NeighbourhoodResult,
  NoteId,
  NodeUuid,
  PillNeighborDot,
  PillNeighborDotState,
  Region,
  RegionId,
  SearchResult,
  SemanticZoomLevel,
  SpatialTabNodeRecord,
  StickyNote,
  SubPageRef,
  UrlHash,
  ViewMode,
  VoiceMemo,
} from '../lib/types'

/* ------------------------------------------------------------------ */
/* Tunable constants (exported so builders/tests pin the exact numbers) */
/* ------------------------------------------------------------------ */

/** §6 — ghost suggestions spawn above this relevance. */
export const GHOST_ECHO_THRESHOLD = 0.78

/** §6 — relevance = 0.55·cosine + 0.30·normalizedCoVisitation + 0.15·recency. */
export const GHOST_SCORE_WEIGHTS = { cosine: 0.55, coVisit: 0.3, recency: 0.15 } as const

/** §6 — switching directly A→B within ~10s increments their edge weight. */
export const CO_VISITATION_WINDOW_MS = 10_000

/** Max ghost echoes materialized per active node. */
export const GHOST_MAX_SUGGESTIONS = 3

/** §3 — Active Workbench Tray holds the 3–5 currently live tabs. */
export const WORKBENCH_SIZE = 5

/** §4.6 — satellites spawn radially near their parent at this radius. */
export const SPAWN_RADIUS = 190

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
const GHOST_TETHER_DISTANCE = 150
const LOADING_PULSE_MS = 700

/* ------------------------------------------------------------------ */
/* Store types                                                         */
/* ------------------------------------------------------------------ */

export type GraphState = {
  /* --- persisted core --- */
  nodes: Record<NodeUuid, SpatialTabNodeRecord>
  edges: Record<EdgeId, GraphEdgeRecord>
  regions: Record<RegionId, Region>
  notes: Record<NoteId, StickyNote>
  voiceMemos: Record<MemoId, VoiceMemo>
  activeNodeUuid: NodeUuid | null
  /** §4.5 — parents whose child stacks are collapsed into a card deck. */
  collapsedStacks: NodeUuid[]
  /** null until a seed ran; FIRST_RUN_SEED_VERSION or STRESS_SEED_VERSION after. */
  seededVersion: number | null
  viewMode: ViewMode

  /* --- runtime-only (excluded from persist) --- */
  hasHydrated: boolean
  paletteOpen: boolean
  glanceOpen: boolean
  physicsFrozen: boolean
  /**
   * LOD lock: the semantic-zoom tier pinned when the lock was engaged
   * (null = unlocked). While pinned, wheel zooming does not step tiers;
   * unlocking resumes natural tier-stepping. A user preference, not an
   * ephemeral glitch flag — it survives canvas ⇄ reading round trips.
   */
  semanticZoomOverride: SemanticZoomLevel | null
  /** Current canvas zoom (0.15x–2.0x) driving semantic-zoom LOD. */
  zoom: number
  /** Voice memo currently recording — global immunity key (§5.3). */
  recordingNodeId: NodeUuid | null
  /** §6 Active Workbench MRU (max 5). */
  workbenchUuids: NodeUuid[]
  /** §5.2 — last auto-eviction, consumed by the toast surface. */
  lastEviction: EvictionNotice | null
  /** Ghost url_hashes dismissed this session ("fade away on context switch"). */
  suppressedGhostHashes: UrlHash[]
}

export type GraphActions = {
  /* --- seeding --- */
  /** Idempotent: applies the §9 28-tab seed on first launch only. */
  ensureFirstRunSeed(): void
  /** Wipes everything and re-applies the first-run seed. */
  resetToFirstRun(): void
  /** §5.4 — /seed-700: replaces the graph with 700 designer reference nodes across 7 clusters. */
  seed700(): void
  /**
   * Phase 1.5 "Tidy to Moodboard Grid" — snaps a region's nodes onto a crisp
   * aligned contact-sheet grid while preserving ALL graph edges (edges are
   * never rewritten; only node coordinates change). Pinned anchors never
   * move (§6 immobility), ghost-echo nodes are skipped (they must stay
   * tethered beside their active node).
   */
  tidyToMoodboard(regionId: RegionId): void

  /* --- navigation & the live pool --- */
  /** Activates a node: marks live, touches recency, records co-visitation, prunes stale ghosts, spawns new ghosts, enforces the pool. */
  activateNode(uuid: NodeUuid): void
  /** Activate + switch to canvas view (glance "focus on canvas"). */
  focusNodeOnCanvas(uuid: NodeUuid): void
  /** Activate + switch to reading viewport ("Open Viewport" hover action). */
  openNodeInViewport(uuid: NodeUuid): void
  /** §5.1 normal click — navigates the ACTIVE node in place; oauth/payment URLs tag `viaAuth` (§7.2). */
  navigateActiveNode(url: string, title?: string, searchQuery?: string): void
  /** §5.1 Cmd/Ctrl+Click — spawns a live child satellite near its parent with a directional spawn edge. */
  spawnChildNode(parentUuid: NodeUuid, seed: { url: string; title: string; searchQuery?: string }): NodeUuid
  /** §3 /new — fresh live tab near the active node, then activates it. */
  createNewTab(init?: { title?: string; url?: string }): NodeUuid
  /** §4.2 — wake a hibernated node to LIVE (pool enforcement applies). */
  wakeNode(uuid: NodeUuid): void
  /** Manual hibernate; returns false when blocked (node is recording — §5.3). */
  hibernateNode(uuid: NodeUuid): boolean
  /** §3 /hibernate-all — hibernates every live tab that isn't immune or active. Returns the count. */
  hibernateAll(): number
  /** §5.3 — mock "playing audio" toggle. */
  toggleAudible(uuid: NodeUuid): void
  /** Internal: clears the simulated navigation loading pulse flag. */
  setNodeLoading(uuid: NodeUuid, loading: boolean): void
  /** §4.6 — pin/unpin an anchor; pinning locks (fx, fy) to the current position. */
  pinNode(uuid: NodeUuid, pinned: boolean): void
  /** Drag-to-anchor commit; `opts.pin` locks (fx, fy), `opts.settle` marks the satellite settled (default true). */
  moveNode(uuid: NodeUuid, x: number, y: number, opts?: { pin?: boolean; settle?: boolean }): void
  /** Hybrid layout settle callback — commits a freshly spawned satellite's position. */
  commitSatellitePosition(uuid: NodeUuid, x: number, y: number): void

  /* --- macro stacks (§4.5) --- */
  collapseStack(parentUuid: NodeUuid): void
  fanStack(parentUuid: NodeUuid): void
  toggleStack(parentUuid: NodeUuid): void

  /* --- sticky notes (attach to url_hash, §7.6) --- */
  addStickyNote(urlHash: UrlHash, text?: string): NoteId
  updateStickyNote(noteId: NoteId, text: string): void
  deleteStickyNote(noteId: NoteId): void
  /** §3 /note + Alt+N — empty note on the active node's url_hash; returns its id for inline editing. */
  quickNoteOnActive(): NoteId | null

  /* --- voice memos (§4.4) --- */
  addVoiceMemo(input: { nodeId: NodeUuid; title: string; durationMs: number; audioSrc: string }): MemoId
  deleteVoiceMemo(memoId: MemoId): void
  setVoiceMemoTitle(memoId: MemoId, title: string): void

  /* --- regions (§6) --- */
  createRegion(name: string, center?: { x: number; y: number }, color?: string): RegionId
  renameRegion(regionId: RegionId, name: string): void
  deleteRegion(regionId: RegionId): void
  /** §3 /cluster — wraps the active node + its 1-hop neighbourhood into a new region. */
  createClusterFromActive(name?: string): RegionId | null

  /* --- SPA sub-navigation (§7.3) --- */
  pushSubPage(uuid: NodeUuid, sub: SubPageRef): void

  /* --- ghost echoes (§4.3, §6) --- */
  /** Recomputes + materializes ghost suggestions for the current active node. */
  refreshGhostEchoes(): void
  /** Dismiss (✕): removes the ghost and suppresses its url_hash for the session. */
  dismissGhostEcho(uuid: NodeUuid): void
  /** Wake Here: links/wakes (or materializes) the predicted tab, dissolves the ghost. Returns the target uuid. */
  wakeGhostEcho(uuid: NodeUuid): NodeUuid

  /* --- ui / runtime --- */
  setHasHydrated(hasHydrated: boolean): void
  /** Post-rehydrate cleanup: clears loading flags, recording lock, transient overlays. */
  clearEphemeralFlags(): void
  setViewMode(mode: ViewMode): void
  /** §10 Cmd/Ctrl+Space / Alt+Space — canvas ⇄ reading. */
  toggleCanvas(): void
  setPaletteOpen(open: boolean): void
  togglePalette(): void
  setGlanceOpen(open: boolean): void
  toggleGlance(): void
  setPhysicsFrozen(frozen: boolean): void
  togglePhysicsFrozen(): void
  setSemanticZoomOverride(tier: SemanticZoomLevel | null): void
  /** Engages the LOD lock on the currently displayed tier / releases it. */
  toggleSemanticZoomOverride(): void
  setZoom(zoom: number): void
  /** Voice recorder reports the node it records on (immunity + pill dot). */
  setRecordingNode(uuid: NodeUuid | null): void
  clearLastEviction(): void
}

export type GraphStore = GraphState & GraphActions

/** Subset written to localStorage by the persist middleware. */
export type PersistedGraphState = Pick<
  GraphState,
  | 'nodes'
  | 'edges'
  | 'regions'
  | 'notes'
  | 'voiceMemos'
  | 'activeNodeUuid'
  | 'collapsedStacks'
  | 'seededVersion'
  | 'viewMode'
>

/* ------------------------------------------------------------------ */
/* Pure domain helpers (exported for builders + tests)                 */
/* ------------------------------------------------------------------ */

/** Embedding corpus for a node: title + domain + keywords + query + cached excerpt. */
export function corpusForNode(node: SpatialTabNodeRecord): string {
  return [node.title, node.domain, ...node.keywords, node.searchQuery ?? '', (node.excerpt ?? '').slice(0, 400)]
    .join(' ')
    .trim()
}

/**
 * §6 Ghost Echo scoring, exactly:
 * `relevance = 0.55·cosineSimilarity + 0.30·normalizedCoVisitation + 0.15·recencyDecay`.
 * Co-visitation is normalized by the strongest edge on the active node;
 * recency decays exponentially with a 14-day scale (§4.2).
 */
export function scoreGhostEcho(
  active: SpatialTabNodeRecord,
  candidate: SpatialTabNodeRecord,
  edgeWeight: number,
  maxEdgeWeightFromActive: number,
  now: number,
): GhostEchoScoreBreakdown {
  const cosine = cosineSimilarity(embedText(corpusForNode(active)), embedText(corpusForNode(candidate)))
  const coVisit = maxEdgeWeightFromActive > 0 ? Math.min(1, edgeWeight / maxEdgeWeightFromActive) : 0
  const recency = Math.exp(-daysSince(candidate.lastVisitedAt, now) / COLD_ARCHIVE_DAYS)
  const relevance =
    GHOST_SCORE_WEIGHTS.cosine * cosine + GHOST_SCORE_WEIGHTS.coVisit * coVisit + GHOST_SCORE_WEIGHTS.recency * recency
  return { cosine, coVisit, recency, relevance }
}

function makeEvictionNotice(node: SpatialTabNodeRecord, now: number): EvictionNotice {
  return { uuid: node.uuid, title: node.title, at: now, reason: 'pool-limit' }
}

function newUuid(): NodeUuid {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Undirected adjacency: uuid → { neighbours, maxEdgeWeight }. */
function buildAdjacency(edges: Record<EdgeId, GraphEdgeRecord>): Map<NodeUuid, { targets: Map<NodeUuid, number>; maxWeight: number }> {
  const adjacency = new Map<NodeUuid, { targets: Map<NodeUuid, number>; maxWeight: number }>()
  const touch = (uuid: NodeUuid, other: NodeUuid, weight: number) => {
    let entry = adjacency.get(uuid)
    if (!entry) {
      entry = { targets: new Map(), maxWeight: 0 }
      adjacency.set(uuid, entry)
    }
    entry.targets.set(other, Math.max(entry.targets.get(other) ?? 0, weight))
    entry.maxWeight = Math.max(entry.maxWeight, weight)
  }
  for (const edgeRecord of Object.values(edges)) {
    touch(edgeRecord.source, edgeRecord.target, edgeRecord.weight)
    touch(edgeRecord.target, edgeRecord.source, edgeRecord.weight)
  }
  return adjacency
}

function pruneDanglingEdges(
  edges: Record<EdgeId, GraphEdgeRecord>,
  nodes: Record<NodeUuid, SpatialTabNodeRecord>,
): Record<EdgeId, GraphEdgeRecord> {
  const next: Record<EdgeId, GraphEdgeRecord> = {}
  for (const [id, edgeRecord] of Object.entries(edges)) {
    if (nodes[edgeRecord.source] && nodes[edgeRecord.target]) next[id] = edgeRecord
  }
  return next
}

/**
 * §6 — materializes ghost-echo nodes for an active node. Candidate uuids are
 * deterministic (`ghost:<active>:<candidate>`), so repeated refreshes never
 * duplicate. Ghosts are hibernated, ephemeral, tethered near the active node
 * at golden-angle offsets.
 */
function materializeGhosts(
  active: SpatialTabNodeRecord,
  nodes: Record<NodeUuid, SpatialTabNodeRecord>,
  edges: Record<EdgeId, GraphEdgeRecord>,
  suppressedHashes: UrlHash[],
  now: number,
): { nodes: Record<NodeUuid, SpatialTabNodeRecord>; edges: Record<EdgeId, GraphEdgeRecord> } {
  const candidates = computeGhostEchoCandidates(active, nodes, edges, suppressedHashes, now, GHOST_MAX_SUGGESTIONS)
  if (candidates.length === 0) return { nodes, edges }
  const nextNodes = { ...nodes }
  const nextEdges = { ...edges }
  candidates.forEach((candidate, index) => {
    const ghostUuid = `ghost:${active.uuid}:${candidate.node.uuid}`
    if (nextNodes[ghostUuid]) return
    const angle = index * GOLDEN_ANGLE
    const ghost: SpatialTabNodeRecord = {
      uuid: ghostUuid,
      urlHash: candidate.node.urlHash,
      url: candidate.node.url,
      domain: candidate.node.domain,
      title: candidate.node.title,
      regionId: active.regionId,
      nodeType: 'ghost-echo',
      ramState: 'hibernated',
      ramMb: 0,
      isAudible: false,
      isPinned: false,
      isLoading: false,
      noCapture: false,
      ephemeral: true,
      viaAuth: false,
      searchQuery: candidate.node.searchQuery,
      subPages: [],
      excerpt: candidate.node.excerpt,
      keywords: candidate.node.keywords,
      parentUuid: null,
      ghostOfUuid: candidate.node.uuid,
      ghostTetherUuid: active.uuid,
      ghostMatch: candidate.relevance,
      settled: true,
      visitCount: 0,
      lastVisitedAt: candidate.node.lastVisitedAt,
      createdAt: now,
      x: active.x + Math.cos(angle) * GHOST_TETHER_DISTANCE,
      y: active.y + Math.sin(angle) * GHOST_TETHER_DISTANCE,
      fx: null,
      fy: null,
    }
    nextNodes[ghostUuid] = ghost
    const edgeId = `ghost-edge:${active.uuid}:${candidate.node.uuid}`
    nextEdges[edgeId] = { id: edgeId, source: active.uuid, target: ghostUuid, weight: 0, kind: 'ghost', createdAt: now }
  })
  return { nodes: nextNodes, edges: nextEdges }
}

/**
 * §6 Ghost Echo matcher — scores every non-live, non-ghost node against the
 * active node and returns those at or above GHOST_ECHO_THRESHOLD, strongest
 * first, capped at `limit`.
 */
export function computeGhostEchoCandidates(
  active: SpatialTabNodeRecord,
  nodes: Record<NodeUuid, SpatialTabNodeRecord>,
  edges: Record<EdgeId, GraphEdgeRecord>,
  suppressedHashes: UrlHash[],
  now: number,
  limit: number,
): GhostEchoCandidate[] {
  const adjacency = buildAdjacency(edges)
  const activeEntry = adjacency.get(active.uuid)
  const maxEdgeWeightFromActive = activeEntry?.maxWeight ?? 0
  const candidates: GhostEchoCandidate[] = []
  for (const node of Object.values(nodes)) {
    if (node.uuid === active.uuid) continue
    if (node.nodeType === 'ghost-echo') continue
    if (node.ramState === 'live') continue
    if (node.urlHash === active.urlHash) continue
    if (suppressedHashes.includes(node.urlHash)) continue
    const weight = activeEntry?.targets.get(node.uuid) ?? 0
    const breakdown = scoreGhostEcho(active, node, weight, maxEdgeWeightFromActive, now)
    if (breakdown.relevance >= GHOST_ECHO_THRESHOLD) {
      candidates.push({ node, ...breakdown })
    }
  }
  return candidates.sort((a, b) => b.relevance - a.relevance).slice(0, limit)
}

/* ------------------------------------------------------------------ */
/* Initial state                                                       */
/* ------------------------------------------------------------------ */

function indexById<T extends { uuid?: string; id?: string }>(items: T[]): Record<string, T> {
  const map: Record<string, T> = {}
  for (const item of items) {
    const key = item.uuid ?? item.id
    if (key) map[key] = item
  }
  return map
}

const initialState: GraphState = {
  nodes: {},
  edges: {},
  regions: {},
  notes: {},
  voiceMemos: {},
  activeNodeUuid: null,
  collapsedStacks: [],
  seededVersion: null,
  viewMode: 'reading',
  hasHydrated: false,
  paletteOpen: false,
  glanceOpen: false,
  physicsFrozen: false,
  semanticZoomOverride: null,
  zoom: 1,
  recordingNodeId: null,
  workbenchUuids: [],
  lastEviction: null,
  suppressedGhostHashes: [],
}

/* ------------------------------------------------------------------ */
/* Persist storage — fragment-cached, cadence-limited writer           */
/* ------------------------------------------------------------------ */

/** The persist key — needed by the debounced writer's flush closure. */
const PERSIST_KEY = 'spatial-canvas-phase-1'

/** Persist write debounce window (ms). */
const PERSIST_DEBOUNCE_MS = 250

/**
 * Minimum wall-clock spacing between actual localStorage writes. The graph
 * serializes to several hundred KB and localStorage.setItem is synchronous —
 * a write every 250ms during a pan/zoom storm stalls real frames (measured:
 * p95 frame 50.1ms). Interaction-time writes are spaced to 1s; `pagehide`
 * always flushes immediately so a normal tab close never loses the last
 * change.
 */
const PERSIST_MIN_FLUSH_INTERVAL_MS = 1000

/**
 * Fragment-identity JSON cache. Graph slices are immutable, so a slice's
 * JSON only changes when its object identity changes; high-frequency writes
 * that touch nothing persisted (zoom, pan, UI flags) re-assemble the payload
 * from cached fragments instead of re-stringifying the whole graph.
 */
const sliceJsonCache = new Map<string, { source: unknown; json: string }>()

function cachedSliceJson(key: string, source: unknown): string {
  const hit = sliceJsonCache.get(key)
  if (hit && hit.source === source) return hit.json
  const json = JSON.stringify(source)
  sliceJsonCache.set(key, { source, json })
  return json
}

/**
 * Typed PersistStorage over localStorage with the trailing-debounce writer
 * above plus the flush-cadence limit. Implemented directly (instead of
 * `createJSONStorage`) so the fragment cache sits inside the serialization
 * boundary — zustand hands us the partialized object and we assemble the
 * payload from cached per-slice fragments.
 */
function createDebouncedPersistStorage(): PersistStorage<PersistedGraphState> {
  let timer: number | null = null
  let pendingPayload: string | null = null
  let lastFlushAt = 0

  const writeToLocalStorage = (payload: string) => {
    try {
      localStorage.setItem(PERSIST_KEY, payload)
    } catch {
      // Quota/serialization failure — the next successful write wins.
    }
    lastFlushAt = Date.now()
  }

  /**
   * The localStorage write is synchronous and can cost tens of ms at graph
   * scale — scheduling it through requestIdleCallback (2s timeout cap,
   * setTimeout fallback) keeps it out of active animation frames. pagehide
   * still flushes synchronously.
   */
  const scheduleWrite = (payload: string) => {
    const write = () => writeToLocalStorage(payload)
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(write, { timeout: 2000 })
    } else {
      window.setTimeout(write, 0)
    }
  }

  const flush = () => {
    if (timer !== null) {
      window.clearTimeout(timer)
      timer = null
    }
    const payload = pendingPayload
    pendingPayload = null
    if (payload === null) return
    const sinceLast = Date.now() - lastFlushAt
    if (sinceLast < PERSIST_MIN_FLUSH_INTERVAL_MS) {
      // Inside the cadence window: defer past it (trailing — the payload is
      // always written, just not mid-gesture).
      timer = window.setTimeout(() => {
        timer = null
        scheduleWrite(payload)
      }, PERSIST_MIN_FLUSH_INTERVAL_MS - sinceLast)
      return
    }
    scheduleWrite(payload)
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flush)
  }

  return {
    getItem: (name) => {
      const raw = localStorage.getItem(name)
      if (raw === null) return null
      try {
        return JSON.parse(raw) as StorageValue<PersistedGraphState>
      } catch {
        return null
      }
    },

    setItem: (_name, value) => {
      const persisted = (value.state ?? {}) as PersistedGraphState
      const version = value.version ?? 0
      const fragments = [
        `"version":${JSON.stringify(version)}`,
        `"state":{`,
        `"nodes":${cachedSliceJson('nodes', persisted.nodes)}`,
        `"edges":${cachedSliceJson('edges', persisted.edges)}`,
        `"regions":${cachedSliceJson('regions', persisted.regions)}`,
        `"notes":${cachedSliceJson('notes', persisted.notes)}`,
        `"voiceMemos":${cachedSliceJson('voiceMemos', persisted.voiceMemos)}`,
        `"collapsedStacks":${cachedSliceJson('collapsedStacks', persisted.collapsedStacks)}`,
        `"activeNodeUuid":${JSON.stringify(persisted.activeNodeUuid)}`,
        `"seededVersion":${JSON.stringify(persisted.seededVersion)}`,
        `"viewMode":${JSON.stringify(persisted.viewMode)}`,
        `}`,
      ]
      pendingPayload = fragments.join('')
      if (timer !== null) return
      timer = window.setTimeout(() => {
        timer = null
        flush()
      }, PERSIST_DEBOUNCE_MS)
    },
    removeItem: (name) => {
      pendingPayload = null
      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
      localStorage.removeItem(name)
    },
  }
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

export const useGraphStore = create<GraphStore>()(
  persist(
    (set, get) => {
      /** Simulated navigation pulse: clears `isLoading` shortly after a navigate/spawn. */
      const scheduleLoadingPulse = (uuid: NodeUuid) => {
        setTimeout(() => {
          set((state) => {
            const node = state.nodes[uuid]
            if (!node || !node.isLoading) return state
            return { nodes: { ...state.nodes, [uuid]: { ...node, isLoading: false } } }
          })
        }, LOADING_PULSE_MS)
      }

      const applySeed = (seed: ReturnType<typeof buildCleanFirstRunState>, version: number, viewMode: ViewMode, zoom: number) => {
        set({
          nodes: indexById(seed.nodes),
          edges: indexById(seed.edges),
          regions: indexById(seed.regions),
          notes: indexById(seed.notes),
          voiceMemos: indexById(seed.memos),
          activeNodeUuid: seed.activeNodeUuid,
          collapsedStacks: [],
          seededVersion: version,
          viewMode,
          zoom,
          workbenchUuids: [seed.activeNodeUuid],
          lastEviction: null,
          suppressedGhostHashes: [],
          recordingNodeId: null,
          paletteOpen: false,
          glanceOpen: false,
          // A seed replaces the whole world — release a stale LOD lock so the
          // new world is always first seen at its natural seeded zoom tier.
          semanticZoomOverride: null,
        })
      }

      return {
        ...initialState,

        /* ---------------- seeding ---------------- */

        ensureFirstRunSeed: () => {
          if (get().seededVersion !== null) return
          applySeed(buildCleanFirstRunState(Date.now()), FIRST_RUN_SEED_VERSION, 'reading', 1)
        },

        resetToFirstRun: () => {
          applySeed(buildCleanFirstRunState(Date.now()), FIRST_RUN_SEED_VERSION, 'reading', 1)
        },

        seed700: () => {
          applySeed(buildStressSeed700(Date.now()), STRESS_SEED_VERSION, 'canvas', 0.3)
        },

        tidyToMoodboard: (regionId) => {
          const state = get()
          if (!state.regions[regionId]) return
          const members = Object.values(state.nodes).filter(
            (node) => node.regionId === regionId && node.nodeType !== 'ghost-echo',
          )
          if (members.length === 0) return
          const result = computeMoodboardGrid(
            members.map((node) => ({ uuid: node.uuid, x: node.x, y: node.y, isPinned: node.isPinned })),
          )
          const nextNodes: Record<NodeUuid, SpatialTabNodeRecord> = { ...state.nodes }
          let moved = 0
          for (const uuid of result.moved) {
            const node = nextNodes[uuid]
            const placement = result.positions[uuid]
            if (!node || !placement) continue
            if (node.x === placement.x && node.y === placement.y) continue
            moved += 1
            // Coordinates only — `fx`/`fy` stay untouched (free nodes keep
            // fx=null; pinned anchors never appear in result.moved), and
            // every edge survives intact.
            nextNodes[uuid] = { ...node, x: placement.x, y: placement.y }
          }
          if (moved > 0) set({ nodes: nextNodes })
        },

        /* ---------------- navigation & live pool ---------------- */

        activateNode: (uuid) => {
          const state = get()
          const target = state.nodes[uuid]
          if (!target) return
          if (target.nodeType === 'ghost-echo') {
            get().wakeGhostEcho(uuid) // activating a ghost means "Wake Here" (§4.3)
            return
          }
          const now = Date.now()
          const previous = state.activeNodeUuid ? state.nodes[state.activeNodeUuid] : undefined

          const nextNodes: Record<NodeUuid, SpatialTabNodeRecord> = { ...state.nodes }
          nextNodes[uuid] = {
            ...target,
            ramState: 'live',
            ramMb: target.ramState === 'live' ? target.ramMb : ramMbFor(uuid),
            lastVisitedAt: now,
            visitCount: target.visitCount + 1,
            isLoading: false,
          }

          // §6 co-visitation: switching directly within ~10s increments the edge weight.
          const nextEdges: Record<EdgeId, GraphEdgeRecord> = { ...state.edges }
          if (previous && previous.uuid !== uuid && now - previous.lastVisitedAt <= CO_VISITATION_WINDOW_MS) {
            const edgeId = `${previous.uuid}->${uuid}`
            const existing = nextEdges[edgeId]
            nextEdges[edgeId] = existing
              ? { ...existing, weight: existing.weight + 1 }
              : { id: edgeId, source: previous.uuid, target: uuid, weight: 1, kind: 'visit', createdAt: now }
          }

          // §6 — ignoring ghosts lets them fade away cleanly on context switch.
          for (const [id, node] of Object.entries(nextNodes)) {
            if (node.nodeType === 'ghost-echo' && node.ghostTetherUuid !== uuid) delete nextNodes[id]
          }

          const ghosted = materializeGhosts(nextNodes[uuid], nextNodes, nextEdges, state.suppressedGhostHashes, now)
          const pool = enforceLivePool(ghosted.nodes, state.recordingNodeId, uuid)

          set({
            nodes: pool.nodes,
            edges: pruneDanglingEdges(ghosted.edges, pool.nodes),
            activeNodeUuid: uuid,
            workbenchUuids: [uuid, ...state.workbenchUuids.filter((id) => id !== uuid)].slice(0, WORKBENCH_SIZE),
            lastEviction: pool.evicted ? makeEvictionNotice(pool.evicted, now) : state.lastEviction,
          })
        },

        focusNodeOnCanvas: (uuid) => {
          get().activateNode(uuid)
          set({ viewMode: 'canvas' })
        },

        openNodeInViewport: (uuid) => {
          get().activateNode(uuid)
          set({ viewMode: 'reading' })
        },

        navigateActiveNode: (url, title, searchQuery) => {
          const state = get()
          if (!state.activeNodeUuid) return
          const node = state.nodes[state.activeNodeUuid]
          if (!node) return
          const now = Date.now()
          set({
            nodes: {
              ...state.nodes,
              [node.uuid]: {
                ...node,
                url,
                urlHash: urlHashOf(url),
                domain: domainOf(url),
                title: title ?? node.title,
                searchQuery: searchQuery ?? node.searchQuery,
                viaAuth: node.viaAuth || looksLikeAuthOrPaymentUrl(url),
                isLoading: true,
                lastVisitedAt: now,
                visitCount: node.visitCount + 1,
              },
            },
          })
          scheduleLoadingPulse(node.uuid)
        },

        spawnChildNode: (parentUuid, seed) => {
          const state = get()
          const parent = state.nodes[parentUuid]
          if (!parent) return ''
          const now = Date.now()
          const childCount = Object.values(state.nodes).filter((node) => node.parentUuid === parentUuid).length
          const angle = childCount * GOLDEN_ANGLE
          const uuid = newUuid()
          const url = seed.url
          const created: SpatialTabNodeRecord = {
            uuid,
            urlHash: urlHashOf(url),
            url,
            domain: domainOf(url),
            title: seed.title.trim() || domainOf(url),
            regionId: parent.regionId,
            nodeType: 'tab',
            ramState: 'live',
            ramMb: ramMbFor(uuid),
            isAudible: false,
            isPinned: false,
            isLoading: true,
            noCapture: false,
            ephemeral: false,
            viaAuth: looksLikeAuthOrPaymentUrl(url),
            searchQuery: seed.searchQuery ?? null,
            subPages: [],
            excerpt: null,
            keywords: Array.from(new Set([domainOf(url), ...tokenize(seed.title)])).slice(0, 8),
            parentUuid,
            ghostOfUuid: null,
            ghostTetherUuid: null,
            ghostMatch: null,
            settled: false,
            visitCount: 1,
            lastVisitedAt: now,
            createdAt: now,
            x: parent.x + Math.cos(angle) * SPAWN_RADIUS,
            y: parent.y + Math.sin(angle) * SPAWN_RADIUS,
            fx: null,
            fy: null,
          }
          const nextNodes: Record<NodeUuid, SpatialTabNodeRecord> = { ...state.nodes, [uuid]: created }
          const edgeId = `${parentUuid}->${uuid}`
          const nextEdges: Record<EdgeId, GraphEdgeRecord> = {
            ...state.edges,
            [edgeId]: { id: edgeId, source: parentUuid, target: uuid, weight: 1, kind: 'spawn', createdAt: now },
          }
          const pool = enforceLivePool(nextNodes, state.recordingNodeId, state.activeNodeUuid)
          scheduleLoadingPulse(uuid)
          set({
            nodes: pool.nodes,
            edges: nextEdges,
            lastEviction: pool.evicted ? makeEvictionNotice(pool.evicted, now) : state.lastEviction,
          })
          return uuid
        },

        createNewTab: (init) => {
          const state = get()
          const now = Date.now()
          const base = state.activeNodeUuid ? state.nodes[state.activeNodeUuid] : undefined
          const uuid = newUuid()
          const url = init?.url ?? 'https://new-tab.spatial/local'
          const created: SpatialTabNodeRecord = {
            uuid,
            urlHash: urlHashOf(url),
            url,
            domain: domainOf(url),
            title: init?.title?.trim() || 'New Tab',
            regionId: base?.regionId ?? null,
            nodeType: 'tab',
            ramState: 'live',
            ramMb: ramMbFor(uuid),
            isAudible: false,
            isPinned: false,
            isLoading: false,
            noCapture: false,
            ephemeral: false,
            viaAuth: looksLikeAuthOrPaymentUrl(url),
            searchQuery: null,
            subPages: [],
            excerpt: null,
            keywords: ['new-tab', 'spatial'],
            parentUuid: null,
            ghostOfUuid: null,
            ghostTetherUuid: null,
            ghostMatch: null,
            settled: true,
            visitCount: 1,
            lastVisitedAt: now,
            createdAt: now,
            x: (base?.x ?? 0) + 80,
            y: (base?.y ?? 0) + 120,
            fx: null,
            fy: null,
          }
          const nextNodes: Record<NodeUuid, SpatialTabNodeRecord> = { ...state.nodes, [uuid]: created }
          const pool = enforceLivePool(nextNodes, state.recordingNodeId, state.activeNodeUuid)
          set({
            nodes: pool.nodes,
            activeNodeUuid: uuid,
            workbenchUuids: [uuid, ...state.workbenchUuids].slice(0, WORKBENCH_SIZE),
            lastEviction: pool.evicted ? makeEvictionNotice(pool.evicted, now) : state.lastEviction,
          })
          return uuid
        },

        wakeNode: (uuid) => {
          const state = get()
          const node = state.nodes[uuid]
          if (!node || node.ramState === 'live') return
          const now = Date.now()
          const nextNodes: Record<NodeUuid, SpatialTabNodeRecord> = {
            ...state.nodes,
            [uuid]: { ...node, ramState: 'live', ramMb: ramMbFor(uuid), lastVisitedAt: now },
          }
          const pool = enforceLivePool(nextNodes, state.recordingNodeId, state.activeNodeUuid)
          set({
            nodes: pool.nodes,
            lastEviction: pool.evicted ? makeEvictionNotice(pool.evicted, now) : state.lastEviction,
          })
        },

        hibernateNode: (uuid) => {
          const state = get()
          const node = state.nodes[uuid]
          if (!node || node.ramState !== 'live') return false
          if (node.uuid === state.recordingNodeId) return false // §5.3
          set({
            nodes: { ...state.nodes, [uuid]: { ...node, ramState: 'hibernated', ramMb: 0, isLoading: false } },
          })
          return true
        },

        hibernateAll: () => {
          const state = get()
          let count = 0
          const nextNodes: Record<NodeUuid, SpatialTabNodeRecord> = { ...state.nodes }
          for (const node of Object.values(state.nodes)) {
            if (node.ramState !== 'live') continue
            if (node.uuid === state.activeNodeUuid) continue
            if (isNodeImmune(node, state.recordingNodeId)) continue
            nextNodes[node.uuid] = { ...node, ramState: 'hibernated', ramMb: 0, isLoading: false }
            count += 1
          }
          if (count > 0) set({ nodes: nextNodes })
          return count
        },

        toggleAudible: (uuid) => {
          const node = get().nodes[uuid]
          if (!node) return
          set({ nodes: { ...get().nodes, [uuid]: { ...node, isAudible: !node.isAudible } } })
        },

        setNodeLoading: (uuid, loading) => {
          const node = get().nodes[uuid]
          if (!node || node.isLoading === loading) return
          set({ nodes: { ...get().nodes, [uuid]: { ...node, isLoading: loading } } })
        },

        pinNode: (uuid, pinned) => {
          const node = get().nodes[uuid]
          if (!node) return
          set({
            nodes: {
              ...get().nodes,
              [uuid]: pinned
                ? { ...node, isPinned: true, fx: node.x, fy: node.y }
                : { ...node, isPinned: false, fx: null, fy: null },
            },
          })
        },

        moveNode: (uuid, x, y, opts) => {
          const node = get().nodes[uuid]
          if (!node) return
          const pin = opts?.pin ?? false
          const settle = opts?.settle ?? true
          set({
            nodes: {
              ...get().nodes,
              [uuid]: {
                ...node,
                x,
                y,
                fx: pin || node.isPinned ? x : node.fx,
                fy: pin || node.isPinned ? y : node.fy,
                isPinned: pin || node.isPinned,
                settled: settle ? true : node.settled,
              },
            },
          })
        },

        commitSatellitePosition: (uuid, x, y) => {
          get().moveNode(uuid, x, y, { settle: true })
        },

        /* ---------------- macro stacks (§4.5) ---------------- */

        collapseStack: (parentUuid) => {
          set((state) =>
            state.collapsedStacks.includes(parentUuid)
              ? state
              : { collapsedStacks: [...state.collapsedStacks, parentUuid] },
          )
        },

        fanStack: (parentUuid) => {
          set((state) => ({ collapsedStacks: state.collapsedStacks.filter((uuid) => uuid !== parentUuid) }))
        },

        toggleStack: (parentUuid) => {
          if (get().collapsedStacks.includes(parentUuid)) get().fanStack(parentUuid)
          else get().collapseStack(parentUuid)
        },

        /* ---------------- sticky notes (§7.6) ---------------- */

        addStickyNote: (urlHash, text) => {
          const state = get()
          const now = Date.now()
          const id = `note-${newUuid()}`
          const created: StickyNote = { id, urlHash, text: text ?? '', createdAt: now, updatedAt: now }
          set({ notes: { ...state.notes, [id]: created } })
          return id
        },

        updateStickyNote: (noteId, text) => {
          const note = get().notes[noteId]
          if (!note) return
          set({ notes: { ...get().notes, [noteId]: { ...note, text, updatedAt: Date.now() } } })
        },

        deleteStickyNote: (noteId) => {
          const notes = { ...get().notes }
          delete notes[noteId]
          set({ notes })
        },

        quickNoteOnActive: () => {
          const state = get()
          if (!state.activeNodeUuid) return null
          const node = state.nodes[state.activeNodeUuid]
          if (!node) return null
          return get().addStickyNote(node.urlHash, '')
        },

        /* ---------------- voice memos (§4.4) ---------------- */

        addVoiceMemo: (input) => {
          const state = get()
          if (!state.nodes[input.nodeId]) return ''
          const id = `memo-${newUuid()}`
          const created: VoiceMemo = {
            id,
            nodeId: input.nodeId,
            title: input.title.trim() || 'Voice memo',
            durationMs: Math.max(0, Math.round(input.durationMs)),
            audioSrc: input.audioSrc,
            createdAt: Date.now(),
          }
          set({ voiceMemos: { ...state.voiceMemos, [id]: created } })
          return id
        },

        deleteVoiceMemo: (memoId) => {
          const voiceMemos = { ...get().voiceMemos }
          delete voiceMemos[memoId]
          set({ voiceMemos })
        },

        setVoiceMemoTitle: (memoId, title) => {
          const memo = get().voiceMemos[memoId]
          if (!memo) return
          set({ voiceMemos: { ...get().voiceMemos, [memoId]: { ...memo, title: title.trim() || memo.title } } })
        },

        /* ---------------- regions (§6) ---------------- */

        createRegion: (name, center, color) => {
          const state = get()
          const base = center ?? (state.activeNodeUuid && state.nodes[state.activeNodeUuid]
            ? { x: state.nodes[state.activeNodeUuid].x, y: state.nodes[state.activeNodeUuid].y }
            : { x: 0, y: 0 })
          const id = `region-${newUuid()}`
          const region: Region = {
            id,
            name: name.trim() || 'New Region',
            color: color ?? REGION_COLORS[Object.keys(state.regions).length % REGION_COLORS.length],
            center: base,
            radius: 520,
            createdAt: Date.now(),
          }
          set({ regions: { ...state.regions, [id]: region } })
          return id
        },

        renameRegion: (regionId, name) => {
          const region = get().regions[regionId]
          if (!region) return
          set({ regions: { ...get().regions, [regionId]: { ...region, name: name.trim() || region.name } } })
        },

        deleteRegion: (regionId) => {
          const state = get()
          const regions = { ...state.regions }
          delete regions[regionId]
          const nodes: Record<NodeUuid, SpatialTabNodeRecord> = {}
          for (const [id, node] of Object.entries(state.nodes)) {
            nodes[id] = node.regionId === regionId ? { ...node, regionId: null } : node
          }
          set({ regions, nodes })
        },

        createClusterFromActive: (name) => {
          const state = get()
          if (!state.activeNodeUuid) return null
          const active = state.nodes[state.activeNodeUuid]
          if (!active) return null
          const id = `region-${newUuid()}`
          const region: Region = {
            id,
            name: name?.trim() || `${active.domain} cluster`,
            color: REGION_COLORS[Object.keys(state.regions).length % REGION_COLORS.length],
            center: { x: active.x, y: active.y },
            radius: 420,
            createdAt: Date.now(),
          }
          const nextNodes: Record<NodeUuid, SpatialTabNodeRecord> = {
            ...state.nodes,
            [active.uuid]: { ...active, regionId: id },
          }
          for (const edgeRecord of Object.values(state.edges)) {
            const neighborUuid =
              edgeRecord.source === active.uuid ? edgeRecord.target : edgeRecord.target === active.uuid ? edgeRecord.source : null
            if (!neighborUuid) continue
            const neighbor = nextNodes[neighborUuid]
            if (neighbor && neighbor.nodeType !== 'ghost-echo') nextNodes[neighborUuid] = { ...neighbor, regionId: id }
          }
          set({ regions: { ...state.regions, [id]: region }, nodes: nextNodes })
          return id
        },

        /* ---------------- SPA sub-navigation (§7.3) ---------------- */

        pushSubPage: (uuid, sub) => {
          const node = get().nodes[uuid]
          if (!node) return
          if (node.subPages.some((existing) => existing.url === sub.url)) return
          set({
            nodes: { ...get().nodes, [uuid]: { ...node, subPages: [...node.subPages, sub].slice(-12) } },
          })
        },

        /* ---------------- ghost echoes (§4.3, §6) ---------------- */

        refreshGhostEchoes: () => {
          const state = get()
          if (!state.activeNodeUuid) return
          const active = state.nodes[state.activeNodeUuid]
          if (!active) return
          const now = Date.now()
          const qualifying = new Set(
            computeGhostEchoCandidates(active, state.nodes, state.edges, state.suppressedGhostHashes, now, GHOST_MAX_SUGGESTIONS)
              .map((candidate) => `ghost:${active.uuid}:${candidate.node.uuid}`),
          )
          const nextNodes: Record<NodeUuid, SpatialTabNodeRecord> = { ...state.nodes }
          for (const [id, node] of Object.entries(nextNodes)) {
            if (node.nodeType === 'ghost-echo' && node.ghostTetherUuid === active.uuid && !qualifying.has(id)) {
              delete nextNodes[id]
            }
          }
          const ghosted = materializeGhosts(active, nextNodes, state.edges, state.suppressedGhostHashes, now)
          set({ nodes: ghosted.nodes, edges: pruneDanglingEdges(ghosted.edges, ghosted.nodes) })
        },

        dismissGhostEcho: (uuid) => {
          const state = get()
          const ghost = state.nodes[uuid]
          if (!ghost || ghost.nodeType !== 'ghost-echo') return
          const nextNodes = { ...state.nodes }
          delete nextNodes[uuid]
          set({
            nodes: nextNodes,
            edges: pruneDanglingEdges(state.edges, nextNodes),
            suppressedGhostHashes: state.suppressedGhostHashes.includes(ghost.urlHash)
              ? state.suppressedGhostHashes
              : [...state.suppressedGhostHashes, ghost.urlHash],
          })
        },

        wakeGhostEcho: (uuid) => {
          const state = get()
          const ghost = state.nodes[uuid]
          if (!ghost || ghost.nodeType !== 'ghost-echo') return ''
          const now = Date.now()
          const nextNodes = { ...state.nodes }
          const nextEdges = { ...state.edges }
          let targetUuid = ghost.ghostOfUuid
          if (targetUuid && nextNodes[targetUuid]) {
            const target = nextNodes[targetUuid]
            nextNodes[targetUuid] = {
              ...target,
              ramState: 'live',
              ramMb: target.ramState === 'live' ? target.ramMb : ramMbFor(targetUuid),
              lastVisitedAt: now,
            }
          } else {
            targetUuid = newUuid()
            const materialized: SpatialTabNodeRecord = {
              uuid: targetUuid,
              urlHash: ghost.urlHash,
              url: ghost.url,
              domain: ghost.domain,
              title: ghost.title.replace(/^Ghost — /, ''),
              regionId: ghost.regionId,
              nodeType: 'tab',
              ramState: 'live',
              ramMb: ramMbFor(targetUuid),
              isAudible: false,
              isPinned: false,
              isLoading: false,
              noCapture: false,
              ephemeral: false,
              viaAuth: looksLikeAuthOrPaymentUrl(ghost.url),
              searchQuery: ghost.searchQuery,
              subPages: [],
              excerpt: ghost.excerpt,
              keywords: ghost.keywords,
              parentUuid: null,
              ghostOfUuid: null,
              ghostTetherUuid: null,
              ghostMatch: null,
              settled: true,
              visitCount: 1,
              lastVisitedAt: now,
              createdAt: now,
              x: ghost.x,
              y: ghost.y,
              fx: null,
              fy: null,
            }
            nextNodes[targetUuid] = materialized
          }
          delete nextNodes[uuid]
          const active = state.activeNodeUuid ? state.nodes[state.activeNodeUuid] : undefined
          if (active && targetUuid !== active.uuid) {
            const edgeId = `${active.uuid}->${targetUuid}`
            const existing = nextEdges[edgeId]
            nextEdges[edgeId] = existing
              ? { ...existing, weight: existing.weight + 1 }
              : { id: edgeId, source: active.uuid, target: targetUuid, weight: 1, kind: 'spawn', createdAt: now }
          }
          set({ nodes: nextNodes, edges: pruneDanglingEdges(nextEdges, nextNodes) })
          get().activateNode(targetUuid)
          return targetUuid
        },

        /* ---------------- ui / runtime ---------------- */

        setHasHydrated: (hasHydrated) => set({ hasHydrated }),

        clearEphemeralFlags: () => {
          set((state) => ({
            recordingNodeId: null,
            lastEviction: null,
            paletteOpen: false,
            glanceOpen: false,
            physicsFrozen: false,
            // `semanticZoomOverride` (the LOD lock) is deliberately NOT
            // cleared here: it is a user preference, not an ephemeral
            // glitch flag, and must survive canvas ⇄ reading round trips.
            nodes: Object.fromEntries(
              Object.entries(state.nodes).map(([id, node]) => [id, node.isLoading ? { ...node, isLoading: false } : node]),
            ),
          }))
        },

        setViewMode: (mode) => set({ viewMode: mode }),

        toggleCanvas: () => set((state) => ({ viewMode: state.viewMode === 'reading' ? 'canvas' : 'reading' })),

        setPaletteOpen: (open) => set({ paletteOpen: open }),
        togglePalette: () => set((state) => ({ paletteOpen: !state.paletteOpen })),
        setGlanceOpen: (open) => set({ glanceOpen: open }),
        toggleGlance: () => set((state) => ({ glanceOpen: !state.glanceOpen })),
        setPhysicsFrozen: (frozen) => set({ physicsFrozen: frozen }),
        togglePhysicsFrozen: () => set((state) => ({ physicsFrozen: !state.physicsFrozen })),
        setSemanticZoomOverride: (tier) => set({ semanticZoomOverride: tier }),
        toggleSemanticZoomOverride: () =>
          set((state) => ({
            // Engaging the lock pins the tier currently displayed at the
            // current zoom (never a hard-coded tier); releasing it resumes
            // natural tier-stepping.
            semanticZoomOverride: state.semanticZoomOverride ? null : lodForZoom(state.zoom, null),
          })),
        setZoom: (zoom) => set({ zoom: Math.min(2, Math.max(0.15, zoom)) }),
        setRecordingNode: (uuid) => set({ recordingNodeId: uuid }),
        clearLastEviction: () => set({ lastEviction: null }),
      }
    },
    {
      name: PERSIST_KEY,
      // v2 — Fresh-State Browser Law (master spec §0.2): pre-2 persisted
      // graphs are pre-redesign dev artifacts (the 28-node designer demo).
      // Reset the seed marker so ensureFirstRunSeed() applies the clean
      // single-New-Tab first run on next boot.
      version: 2,
      storage: createDebouncedPersistStorage(),
      partialize: (state): PersistedGraphState => ({
        nodes: state.nodes,
        edges: state.edges,
        regions: state.regions,
        notes: state.notes,
        voiceMemos: state.voiceMemos,
        activeNodeUuid: state.activeNodeUuid,
        collapsedStacks: state.collapsedStacks,
        seededVersion: state.seededVersion,
        viewMode: state.viewMode,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return
        state.clearEphemeralFlags()
        state.setHasHydrated(true)
      },
      migrate: () => {
        // v1 → v2: wipe persisted graph data (dev-era demo state); a null
        // seededVersion makes ensureFirstRunSeed() rebuild the clean state.
        return { seededVersion: null } as unknown as PersistedGraphState
      },
    },
  ),
)

/* ------------------------------------------------------------------ */
/* Selectors (pure state → view-model functions)                       */
/* ------------------------------------------------------------------ */

export function selectActiveNode(state: GraphStore): SpatialTabNodeRecord | null {
  return state.activeNodeUuid ? (state.nodes[state.activeNodeUuid] ?? null) : null
}

/** Live nodes oldest-first (LRU order; the head is the next eviction candidate). */
export function selectLiveNodesLru(state: GraphStore): SpatialTabNodeRecord[] {
  return Object.values(state.nodes)
    .filter((node) => node.ramState === 'live')
    .sort((a, b) => a.lastVisitedAt - b.lastVisitedAt)
}

export function selectLiveCount(state: GraphStore): number {
  let count = 0
  for (const node of Object.values(state.nodes)) if (node.ramState === 'live') count += 1
  return count
}

/**
 * §6 pill dots — the active node first (accent), then 1-hop neighbours:
 * ghosts first, then loading, then the page you came from + siblings of the
 * same link cluster, then the rest by edge weight. Max 6 dots total.
 */
export function selectPillNeighbours(state: GraphStore, uuid: NodeUuid): PillNeighborDot[] {
  const active = state.nodes[uuid]
  if (!active) return []
  const dotFor = (node: SpatialTabNodeRecord): PillNeighborDotState =>
    node.nodeType === 'ghost-echo'
      ? 'ghost'
      : node.isLoading
        ? 'loading'
        : node.ramState === 'hibernated'
          ? 'hibernated'
          : 'live'
  const dots: PillNeighborDot[] = [{ uuid: active.uuid, title: active.title, state: 'active' }]
  const neighbourEntries: Array<{ node: SpatialTabNodeRecord; weight: number; cameFrom: boolean; sibling: boolean }> = []
  for (const edgeRecord of Object.values(state.edges)) {
    const neighborUuid =
      edgeRecord.source === active.uuid ? edgeRecord.target : edgeRecord.target === active.uuid ? edgeRecord.source : null
    if (!neighborUuid || neighborUuid === active.uuid) continue
    const neighbor = state.nodes[neighborUuid]
    if (!neighbor) continue
    neighbourEntries.push({
      node: neighbor,
      weight: edgeRecord.weight,
      cameFrom: edgeRecord.target === active.uuid || active.parentUuid === neighborUuid,
      sibling: active.parentUuid !== null && neighbor.parentUuid === active.parentUuid,
    })
  }
  neighbourEntries.sort((a, b) => {
    const rank = (entry: { node: SpatialTabNodeRecord; cameFrom: boolean; sibling: boolean }): number => {
      if (entry.node.nodeType === 'ghost-echo') return 0
      if (entry.node.isLoading) return 1
      if (entry.cameFrom) return 2
      if (entry.sibling) return 3
      return 4
    }
    const rankDelta = rank(a) - rank(b)
    return rankDelta !== 0 ? rankDelta : b.weight - a.weight
  })
  for (const entry of neighbourEntries) {
    if (dots.length >= 6) break
    dots.push({ uuid: entry.node.uuid, title: entry.node.title, state: dotFor(entry.node) })
  }
  return dots
}

/**
 * §3 Neighbourhood Glance — 1-hop and 2-hop BFS around a node (ghost tether
 * edges included so suggestions surface), with all edges among the visited set.
 */
export function selectNeighbourhood(state: GraphStore, uuid: NodeUuid, maxHops: 1 | 2 = 2): NeighbourhoodResult {
  const start = state.nodes[uuid]
  if (!start) return { nodes: [], edges: [] }
  const adjacency = buildAdjacency(state.edges)
  const depthByUuid = new Map<NodeUuid, 1 | 2>([[uuid, 1]])
  let frontier: NodeUuid[] = [uuid]
  for (let depth = 1; depth <= maxHops; depth++) {
    const nextFrontier: NodeUuid[] = []
    for (const current of frontier) {
      const targets = adjacency.get(current)?.targets
      if (!targets) continue
      for (const target of targets.keys()) {
        if (depthByUuid.has(target)) continue
        const node = state.nodes[target]
        if (!node) continue
        const effectiveDepth = Math.min(depth, 2) as 1 | 2
        depthByUuid.set(target, effectiveDepth)
        nextFrontier.push(target)
      }
    }
    frontier = nextFrontier
  }
  depthByUuid.delete(uuid)
  const entries = [...depthByUuid.entries()]
    .map(([id, depth]) => ({ node: state.nodes[id], depth }))
    .filter((entry): entry is { node: SpatialTabNodeRecord; depth: 1 | 2 } => Boolean(entry.node))
    .sort((a, b) => a.depth - b.depth || b.node.lastVisitedAt - a.node.lastVisitedAt)
  const visited = new Set<NodeUuid>([uuid, ...entries.map((entry) => entry.node.uuid)])
  const edges = Object.values(state.edges).filter((edgeRecord) => visited.has(edgeRecord.source) && visited.has(edgeRecord.target))
  return { nodes: entries, edges }
}

/** Raw ghost suggestions (scored, pre-materialization) for an active node. */
export function selectGhostEchoCandidates(state: GraphStore, uuid?: NodeUuid): GhostEchoCandidate[] {
  const activeUuid = uuid ?? state.activeNodeUuid
  if (!activeUuid) return []
  const active = state.nodes[activeUuid]
  if (!active) return []
  return computeGhostEchoCandidates(active, state.nodes, state.edges, state.suppressedGhostHashes, Date.now(), GHOST_MAX_SUGGESTIONS)
}

/** Materialized ghost-echo nodes, optionally filtered by the node they tether beside. */
export function selectGhostEchoNodes(state: GraphStore, tetherUuid?: NodeUuid): SpatialTabNodeRecord[] {
  return Object.values(state.nodes).filter(
    (node) => node.nodeType === 'ghost-echo' && (tetherUuid ? node.ghostTetherUuid === tetherUuid : true),
  )
}

export function selectNotesForNode(state: GraphStore, uuid: NodeUuid): StickyNote[] {
  const node = state.nodes[uuid]
  if (!node) return []
  return Object.values(state.notes)
    .filter((note) => note.urlHash === node.urlHash)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function selectMemosForNode(state: GraphStore, uuid: NodeUuid): VoiceMemo[] {
  return Object.values(state.voiceMemos)
    .filter((memo) => memo.nodeId === uuid)
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** Direct satellite children (drives the `+N TABS` deck badge, §4.5). */
export function selectChildren(state: GraphStore, uuid: NodeUuid): SpatialTabNodeRecord[] {
  return Object.values(state.nodes)
    .filter((node) => node.parentUuid === uuid)
    .sort((a, b) => a.createdAt - b.createdAt)
}

export function selectStackChildCount(state: GraphStore, uuid: NodeUuid): number {
  let count = 0
  for (const node of Object.values(state.nodes)) if (node.parentUuid === uuid) count += 1
  return count
}

/** §6 Active Workbench — MRU tabs, padded to 3 with the most recent live tabs. */
export function selectWorkbenchNodes(state: GraphStore): SpatialTabNodeRecord[] {
  const picked: SpatialTabNodeRecord[] = []
  const seen = new Set<NodeUuid>()
  for (const uuid of state.workbenchUuids) {
    const node = state.nodes[uuid]
    if (!node || seen.has(uuid)) continue
    picked.push(node)
    seen.add(uuid)
  }
  if (picked.length < 3) {
    const liveByRecency = Object.values(state.nodes)
      .filter((node) => node.ramState === 'live' && !seen.has(node.uuid))
      .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
    for (const node of liveByRecency) {
      if (picked.length >= 3) break
      picked.push(node)
      seen.add(node.uuid)
    }
  }
  return picked.slice(0, WORKBENCH_SIZE)
}

export function selectRegionList(state: GraphStore): Region[] {
  return Object.values(state.regions).sort((a, b) => a.createdAt - b.createdAt)
}

export function selectRegionNodes(state: GraphStore, regionId: RegionId): SpatialTabNodeRecord[] {
  return Object.values(state.nodes).filter((node) => node.regionId === regionId)
}

/** Canvas-visible nodes: everything except children hidden inside collapsed stacks (§4.5). */
export function selectCanvasNodes(state: GraphStore): SpatialTabNodeRecord[] {
  return Object.values(state.nodes).filter(
    (node) => !(node.parentUuid !== null && state.collapsedStacks.includes(node.parentUuid)),
  )
}

/** Canvas-visible edges: both endpoints must be canvas-visible. */
export function selectCanvasEdges(state: GraphStore): GraphEdgeRecord[] {
  const visible = new Set(selectCanvasNodes(state).map((node) => node.uuid))
  return Object.values(state.edges).filter((edgeRecord) => visible.has(edgeRecord.source) && visible.has(edgeRecord.target))
}

/** Subsequence fuzzy score; exact substring hits rank highest. */
function fuzzyScore(query: string, text: string): number {
  if (!text) return 0
  const haystack = text.toLowerCase()
  const exact = haystack.indexOf(query)
  if (exact >= 0) return 3 - Math.min(1.5, exact * 0.02)
  let cursor = 0
  let gaps = 0
  for (let i = 0; i < query.length; i++) {
    const found = haystack.indexOf(query[i], cursor)
    if (found === -1) return 0
    gaps += found - cursor
    cursor = found + 1
  }
  return Math.max(0.4, 1.4 - gaps * 0.015)
}

function snippetAround(text: string, query: string, radius = 56): string {
  const index = text.toLowerCase().indexOf(query)
  if (index === -1) return text.slice(0, radius * 2)
  const start = Math.max(0, index - radius)
  const end = Math.min(text.length, index + query.length + radius)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/**
 * §3 palette fuzzy search across open tabs, hibernated nodes, sticky note
 * text and voice-note titles. Empty query → empty result (the palette shows
 * its own recents/slash commands).
 */
export function selectSearchResults(state: GraphStore, rawQuery: string, limit = 12): SearchResult[] {
  const query = rawQuery.trim().toLowerCase()
  if (!query) return []
  const results: SearchResult[] = []

  for (const node of Object.values(state.nodes)) {
    if (node.nodeType === 'ghost-echo') continue
    const candidates: Array<{ text: string; weight: number }> = [
      { text: node.title, weight: 1.0 },
      { text: node.domain, weight: 0.7 },
      { text: node.url, weight: 0.6 },
      { text: node.searchQuery ?? '', weight: 0.7 },
    ]
    for (const keyword of node.keywords) candidates.push({ text: keyword, weight: 0.7 })
    let best = 0
    let bestText = ''
    for (const candidate of candidates) {
      const score = fuzzyScore(query, candidate.text) * candidate.weight
      if (score > best) {
        best = score
        bestText = candidate.text
      }
    }
    if (best > 0) {
      results.push({
        kind: 'tab',
        id: node.uuid,
        nodeId: node.uuid,
        noteId: null,
        memoId: null,
        title: node.title,
        snippet: `${node.domain} · ${node.ramState === 'live' ? 'Live tab' : isColdArchive(node, Date.now()) ? 'Cold archive' : 'Hibernated'}${bestText ? ` — ${bestText}` : ''}`,
        score: best,
      })
    }
  }

  for (const note of Object.values(state.notes)) {
    const score = fuzzyScore(query, note.text)
    if (score <= 0) continue
    const owner = Object.values(state.nodes).find((node) => node.urlHash === note.urlHash)
    results.push({
      kind: 'note',
      id: note.id,
      nodeId: owner?.uuid ?? null,
      noteId: note.id,
      memoId: null,
      title: owner ? `Note — ${owner.title}` : 'Note',
      snippet: snippetAround(note.text, query),
      score: score * 0.9,
    })
  }

  for (const memo of Object.values(state.voiceMemos)) {
    const score = fuzzyScore(query, memo.title)
    if (score <= 0) continue
    const owner = state.nodes[memo.nodeId]
    const seconds = Math.max(0, Math.round(memo.durationMs / 1000))
    results.push({
      kind: 'memo',
      id: memo.id,
      nodeId: memo.nodeId,
      noteId: null,
      memoId: memo.id,
      title: memo.title,
      snippet: `Voice memo · ${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}${owner ? ` · ${owner.title}` : ''}`,
      score: score * 0.9,
    })
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit)
}
