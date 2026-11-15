/**
 * app/src/store/useGraphStore.ts — zustand + persist store for the spatial
 * graph (SPEC §1, §4, §5, §6, §7).
 *
 * Model: `node_uuid` (unique instance) vs `url_hash` (canonical, shared by
 * duplicates; sticky notes attach to it — §7.6). §B.6 performance-guardrail
 * live pool (default 25, user-tunable 5..100 | 'unlimited', idle hibernation
 * 15/30/60 | 'never', optional RAM ceiling) with audible (2.5 s pause
 * debounce) / pinned / recording immunity (§5.2, §5.3, §7.7). Ghost Echo
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
import {
  DEFAULT_PERFORMANCE_GUARDRAIL,
  enforceLivePool,
  enforceRamCeiling,
  hibernateIdleNodes,
  isNodeImmune,
  normalizeGuardrail,
} from '../lib/livePool'
import type { PerformanceGuardrail } from '../lib/livePool'
import { MOODBOARD_CARD_HEIGHT, MOODBOARD_CARD_WIDTH } from '../lib/moodboard'
import { SUB_PAGES_NAV_CAP, captureAnchorProvenance, decideInPlaceNavigation } from '../lib/trails'
import type { SpawnProvenance } from '../lib/trails'
import {
  batchFuzzySearch,
  computeMoodboardGridCore,
  fuzzyScore,
  getSharedSpatialCuller,
  scoreGhostEchoes,
  urlHashToNumber,
} from '../lib/spatialCore'
import type { GhostCandidateCoreInput, SearchDocCoreInput } from '../lib/spatialCore'
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
  FlowNotch,
  FlowTreeRow,
  GhostEchoCandidate,
  GhostEchoScoreBreakdown,
  GraphEdgeRecord,
  MemoId,
  NeighbourhoodResult,
  NoteId,
  NodeUuid,
  PillNeighborDot,
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

/** How often the idle-hibernation guardrail sweep runs while the shell lives (§B.6). */
export const IDLE_SWEEP_INTERVAL_MS = 60_000

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
  /**
   * §B.7.3 Trace Rabbit Hole — a Glance-pinned trail focus ("Trace trail"
   * action): the canvas illuminates the full upstream→downstream chain from
   * this node while unrelated clusters dim. Runtime-only; hover trails
   * (Alt+Hover) stay local to the canvas component.
   */
  trailFocusUuid: NodeUuid | null
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
  /**
   * §B.6 Working-Session Guardrails — replaces the old hard LIVE_POOL_LIMIT
   * of 5. Persisted: the user's own promise about memory, never a surprise.
   */
  performanceGuardrail: PerformanceGuardrail
  /**
   * §B.6 — uuid → wall-clock timestamp the tab's audio PAUSED. Immunity
   * lingers 2.5 s past a pause so a track gap never hibernates a tab
   * mid-listen. Runtime-only.
   */
  audiblePausedAt: Record<NodeUuid, number>
  /**
   * §B.5 — consumed by the canvas to pan (`fitView`) to a Flow's bounding
   * box. `nonce` makes repeated requests to the same flow fire. Runtime-only;
   * SpatialCanvas consumes it opportunistically.
   */
  canvasFitRequest: { regionId: RegionId; nonce: number } | null
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
  /**
   * §B.7.2 — in-place navigation of the ACTIVE node, guarded by domain:
   * same-domain → previous URL/title joins the subPages[] filmstrip (cap 20);
   * cross-domain → the previous domain freezes as a hibernated parent at its
   * current (x, y) and the new domain spawns as the active connected child
   * (`kind: 'spawn'`). Never a silent overwrite.
   */
  navigateActiveNode(url: string, title?: string, searchQuery?: string, provenance?: SpawnProvenance | null): void
  /** §B.7.3 — pin (or clear) the Trace-Rabbit-Hole focus shown by the Glance. */
  setTrailFocus(uuid: NodeUuid | null): void
  /** §B.7.3 — toggle the trail focus onto `uuid` (Glance "Trace trail" action). */
  toggleTrailFocus(uuid: NodeUuid): void
  /** §5.1 Cmd/Ctrl+Click — spawns a live child satellite near its parent with a directional spawn edge. */
  spawnChildNode(parentUuid: NodeUuid, seed: { url: string; title: string; searchQuery?: string; provenance?: SpawnProvenance | null }): NodeUuid
  /** §3 /new — fresh live tab near the active node, then activates it.
   *  §B.8.4 — `partition: 'sandbox'` marks the node for the isolated
   *  temp:sandbox session when the desktop build wakes its live view. */
  createNewTab(init?: { title?: string; url?: string; partition?: 'default' | 'sandbox' }): NodeUuid
  /** §4.2 — wake a hibernated node to LIVE (pool enforcement applies). */
  wakeNode(uuid: NodeUuid): void
  /** Manual hibernate; returns false when blocked (node is recording — §5.3). */
  hibernateNode(uuid: NodeUuid): boolean
  /** §3 /hibernate-all — hibernates every live tab that isn't immune or active. Returns the count. */
  hibernateAll(): number
  /**
   * §B.6 — park ONE live tab to the 0 MB archive (Horizon 1 per-pill moon):
   * hibernate + drop it from the Active Workbench MRU. Blocked while the
   * node records a voice memo (§5.3); pinned/audible tabs are the user's
   * explicit anchors, but parking is a deliberate user gesture so it is
   * allowed on them.
   */
  parkNodeToArchive(uuid: NodeUuid): boolean
  /**
   * §B.6 — 'Park session' / 'Sleep session': park every live tab that is
   * neither active nor immune to 0 MB. Returns the count parked.
   */
  parkSessionToArchive(): number
  /** §B.6 — merge a guardrail patch (values normalized: clamps, 'unlimited', 'never'). */
  setPerformanceGuardrail(patch: Partial<PerformanceGuardrail>): void
  /**
   * §B.6 — periodic guardrail sweep: idle hibernation per
   * `idleHibernateMinutes` + optional RAM-ceiling enforcement. Returns the
   * number of tabs parked by the idle sweep (0 when 'never').
   */
  sweepIdleHibernation(): number
  /**
   * Close a tab for real: deletes the node, prunes dangling edges, hands
   * recording/active anchors to a sensible neighbour. Deliberate user
   * gesture — allowed on pinned nodes (Stage 0 `×`).
   */
  closeNode(uuid: NodeUuid): void
  /**
   * §B.5 — pan Mode B to a Flow: activates the flow's anchor node, switches
   * to canvas, and issues a `canvasFitRequest` for the flow's bounding box.
   */
  focusRegionOnCanvas(regionId: RegionId): void
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
  /**
   * §B.6 startup restoration — persisted tabs boot hibernated (0 MB) with
   * the active anchor left live. Called once from `onRehydrateStorage`.
   */
  restoreSessionHibernated(): void
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
  | 'performanceGuardrail'
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
  /* Phase 2 spatial core — the shared culler indexes every existing card
     footprint so a ghost echo NEVER spawns on top of one (spec Phase 2 §1a,
     "fast AABB collision checks"). Deterministic: the tether angle advances
     by golden-angle steps until a free slot is found; when every attempt is
     blocked it falls back to the original angle (pre-Phase-2 placement). */
  const keepOut = getSharedSpatialCuller()
  keepOut.setBoxes(
    Object.values(nodes).map((node, index) => ({
      id: index,
      x: node.x,
      y: node.y,
      width: MOODBOARD_CARD_WIDTH,
      height: MOODBOARD_CARD_HEIGHT,
    })),
  )
  candidates.forEach((candidate, index) => {
    const ghostUuid = `ghost:${active.uuid}:${candidate.node.uuid}`
    if (nextNodes[ghostUuid]) return
    const baseAngle = index * GOLDEN_ANGLE
    let angle = baseAngle
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const probeX = active.x + Math.cos(angle) * GHOST_TETHER_DISTANCE
      const probeY = active.y + Math.sin(angle) * GHOST_TETHER_DISTANCE
      if (!keepOut.overlapsAny(probeX, probeY, MOODBOARD_CARD_WIDTH, MOODBOARD_CARD_HEIGHT)) break
      angle += GOLDEN_ANGLE
    }
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
 *
 * Phase 2 spatial core: the filter/sort/cap shell and the batch cosine + co-
 * visit + recency scoring both run through `lib/spatialCore` (Rust WASM when
 * ready, its exact-port TS mirror otherwise). The shell mirrors the previous
 * in-store loop (skip self / ghosts / live / same urlHash / suppressed) so
 * results are identical — `scoreGhostEcho` above stays as the single-pair TS
 * reference.
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
  const candidateInputs: GhostCandidateCoreInput[] = []
  for (const node of Object.values(nodes)) {
    candidateInputs.push({
      uuid: node.uuid,
      title: node.title,
      domain: node.domain,
      keywords: node.keywords,
      searchQuery: node.searchQuery,
      excerpt: node.excerpt,
      edgeWeight: activeEntry?.targets.get(node.uuid) ?? 0,
      lastVisitedAt: node.lastVisitedAt,
      isGhostEcho: node.nodeType === 'ghost-echo',
      isLive: node.ramState === 'live',
      urlHash: urlHashToNumber(node.urlHash),
      urlHashSuppressed: suppressedHashes.includes(node.urlHash),
    })
  }
  const scored = scoreGhostEchoes(
    {
      uuid: active.uuid,
      title: active.title,
      domain: active.domain,
      keywords: active.keywords,
      searchQuery: active.searchQuery,
      excerpt: active.excerpt,
      urlHash: urlHashToNumber(active.urlHash),
    },
    candidateInputs,
    maxEdgeWeightFromActive,
    now,
    limit,
  )
  const candidates: GhostEchoCandidate[] = []
  for (const entry of scored) {
    const node = nodes[entry.uuid]
    if (!node) continue
    candidates.push({
      node,
      cosine: entry.cosine,
      coVisit: entry.coVisit,
      recency: entry.recency,
      relevance: entry.relevance,
    })
  }
  return candidates
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
  trailFocusUuid: null,
  physicsFrozen: false,
  semanticZoomOverride: null,
  zoom: 1,
  recordingNodeId: null,
  workbenchUuids: [],
  lastEviction: null,
  suppressedGhostHashes: [],
  performanceGuardrail: DEFAULT_PERFORMANCE_GUARDRAIL,
  audiblePausedAt: {},
  canvasFitRequest: null,
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
        `"performanceGuardrail":${cachedSliceJson('guardrail', persisted.performanceGuardrail)}`,
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

      /**
       * §B.6 — pool enforcement always carries the user's performance
       * guardrail plus the 2.5 s audio-pause debounce map. One seam so no
       * call site can forget the guardrail.
       */
      const enforcePool = (
        nodes: Record<NodeUuid, SpatialTabNodeRecord>,
        activeUuid: NodeUuid | null,
      ) => {
        const state = get()
        return enforceLivePool(
          nodes,
          state.recordingNodeId,
          activeUuid,
          state.performanceGuardrail,
          state.audiblePausedAt,
        )
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
          trailFocusUuid: null,
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
          const result = computeMoodboardGridCore(
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
          const pool = enforcePool(ghosted.nodes, uuid)

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

        navigateActiveNode: (url, title, searchQuery, provenance) => {
          const state = get()
          if (!state.activeNodeUuid) return
          const node = state.nodes[state.activeNodeUuid]
          if (!node) return
          const now = Date.now()

          // §B.7.2 — Cross-Domain In-Place Navigation Guard. Same-domain
          // navigation stays in place and joins the subPages filmstrip;
          // cross-domain navigation never silently overwrites the node —
          // the previous domain freezes as a hibernated parent at its
          // current (x, y) and the new domain spawns one step forward as
          // the active connected child (`kind: 'spawn'`), so the breadcrumb
          // chain preserves itself.
          const decision = decideInPlaceNavigation(node.domain, url)
          if (decision.kind === 'cross-domain') {
            const captured = captureAnchorProvenance(provenance ?? null)
            const childUuid = get().spawnChildNode(node.uuid, {
              url,
              title: title ?? domainOf(url),
              searchQuery,
              provenance: captured,
            })
            if (!childUuid) return
            // Freeze the previous domain at its CURRENT (x, y) — position is
            // never touched (the "system pays, the user confirms" law).
            const parent = get().nodes[node.uuid]
            if (parent) {
              set({
                nodes: {
                  ...get().nodes,
                  [parent.uuid]: {
                    ...parent,
                    ramState: 'hibernated',
                    ramMb: 0,
                    isLoading: false,
                    lastVisitedAt: now,
                  },
                },
              })
            }
            // The spawned child becomes where the person is reading now.
            set({
              activeNodeUuid: childUuid,
              workbenchUuids: [childUuid, ...state.workbenchUuids.filter((id) => id !== childUuid)].slice(0, WORKBENCH_SIZE),
            })
            scheduleLoadingPulse(childUuid)
            return
          }

          // Same-domain: the filmstrip remembers where the domain has been
          // (§7.3), capped at 20 entries for this navigation path.
          const previousEntry = { url: node.url, title: node.title }
          const appended =
            node.subPages.some((existing) => existing.url === previousEntry.url) || previousEntry.url === url
              ? node.subPages
              : [...node.subPages, previousEntry].slice(-SUB_PAGES_NAV_CAP)
          set({
            nodes: {
              ...state.nodes,
              [node.uuid]: {
                ...node,
                subPages: appended,
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
          // §B.7.1 — provenance rides the spawn edge AND the child record
          // (mirrored so hovers never need an edge lookup).
          const captured = captureAnchorProvenance(seed.provenance ?? null)
          const anchorText = captured?.anchorText ?? null
          const contextSnippet = captured?.contextSnippet ?? null
          const scrollYAtSpawn = captured?.scrollYAtSpawn ?? null
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
            anchorText,
            contextSnippet,
            scrollYAtSpawn,
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
            [edgeId]: {
              id: edgeId,
              source: parentUuid,
              target: uuid,
              weight: 1,
              kind: 'spawn',
              createdAt: now,
              // §B.7.1 — rich provenance on every spawn edge.
              anchorText,
              contextSnippet,
              scrollYAtSpawn,
            },
          }
          const pool = enforcePool(nextNodes, state.activeNodeUuid)
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
            // §B.8.4 — the /sandbox seam: only the sandbox label is ever
            // user-selectable; main re-normalizes on the graph seam anyway.
            partition: init?.partition === 'sandbox' ? 'sandbox' : undefined,
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
          const pool = enforcePool(nextNodes, state.activeNodeUuid)
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
          const pool = enforcePool(nextNodes, state.activeNodeUuid)
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
            if (isNodeImmune(node, state.recordingNodeId, state.audiblePausedAt)) continue
            nextNodes[node.uuid] = { ...node, ramState: 'hibernated', ramMb: 0, isLoading: false }
            count += 1
          }
          if (count > 0) set({ nodes: nextNodes })
          return count
        },

        parkNodeToArchive: (uuid) => {
          const state = get()
          const node = state.nodes[uuid]
          if (!node || node.ramState !== 'live') return false
          if (node.uuid === state.recordingNodeId) return false // §5.3 — never behind the user's back
          set({
            nodes: { ...state.nodes, [uuid]: { ...node, ramState: 'hibernated', ramMb: 0, isLoading: false } },
            workbenchUuids: state.workbenchUuids.filter((id) => id !== uuid),
          })
          return true
        },

        parkSessionToArchive: () => {
          const state = get()
          let count = 0
          const nextNodes: Record<NodeUuid, SpatialTabNodeRecord> = { ...state.nodes }
          for (const node of Object.values(state.nodes)) {
            if (node.ramState !== 'live') continue
            if (node.uuid === state.activeNodeUuid) continue
            if (isNodeImmune(node, state.recordingNodeId, state.audiblePausedAt)) continue
            nextNodes[node.uuid] = { ...node, ramState: 'hibernated', ramMb: 0, isLoading: false }
            count += 1
          }
          if (count > 0) {
            const parkedUuids = new Set(
              Object.keys(state.nodes).filter((id) => nextNodes[id]?.ramState === 'hibernated' && state.nodes[id]?.ramState === 'live'),
            )
            set({
              nodes: nextNodes,
              workbenchUuids: state.workbenchUuids.filter((id) => !parkedUuids.has(id)),
            })
          }
          return count
        },

        setPerformanceGuardrail: (patch) => {
          set((state) => ({ performanceGuardrail: normalizeGuardrail({ ...state.performanceGuardrail, ...patch }) }))
        },

        sweepIdleHibernation: () => {
          const state = get()
          const now = Date.now()
          // §B.6 idle sweep — a live tab untouched past `idleHibernateMinutes`
          // parks itself to 0 MB (the system pays; the user never watches a
          // tab vanish behind an active gesture).
          const idle = hibernateIdleNodes(
            state.nodes,
            state.performanceGuardrail.idleHibernateMinutes,
            now,
            state.activeNodeUuid,
            state.recordingNodeId,
            state.audiblePausedAt,
          )
          let nodes = idle.nodes
          if (nodes === state.nodes && idle.parked === 0) {
            // Idle sweep parked nothing — still honor the optional RAM ceiling.
            const ceiling = state.performanceGuardrail.ramCeilingMb
            if (typeof ceiling === 'number') {
              const capped = enforceRamCeiling(nodes, state.recordingNodeId, state.activeNodeUuid, ceiling, state.audiblePausedAt)
              if (capped.evicted) set({ nodes: capped.nodes, lastEviction: makeEvictionNotice(capped.evicted, now) })
            }
            return 0
          }
          const ceiling = state.performanceGuardrail.ramCeilingMb
          if (typeof ceiling === 'number') {
            nodes = enforceRamCeiling(nodes, state.recordingNodeId, state.activeNodeUuid, ceiling, state.audiblePausedAt).nodes
          }
          set({ nodes })
          return idle.parked
        },

        closeNode: (uuid) => {
          const state = get()
          const node = state.nodes[uuid]
          if (!node) return
          const nextNodes = { ...state.nodes }
          delete nextNodes[uuid]
          // Ghosts tethered beside the closed node lose their anchor — dissolve.
          for (const [id, other] of Object.entries(nextNodes)) {
            if (other.nodeType === 'ghost-echo' && (other.ghostTetherUuid === uuid || other.ghostOfUuid === uuid)) {
              delete nextNodes[id]
            }
          }
          const nextEdges = pruneDanglingEdges(state.edges, nextNodes)
          const nextRecording = state.recordingNodeId === uuid ? null : state.recordingNodeId
          let nextActive = state.activeNodeUuid === uuid ? null : state.activeNodeUuid
          if (nextActive === null) {
            // Hand the session to a sensible neighbour: parent, then a child,
            // then the most recent remaining live tab, then anything.
            const fallback =
              (node.parentUuid && nextNodes[node.parentUuid]) ||
              Object.values(nextNodes).find((candidate) => candidate.parentUuid === uuid) ||
              Object.values(nextNodes)
                .filter((candidate) => candidate.nodeType !== 'ghost-echo')
                .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)[0] ||
              null
            nextActive = fallback?.uuid ?? null
          }
          const nextWorkbench = state.workbenchUuids.filter((id) => nextNodes[id])
          set({
            nodes: nextNodes,
            edges: nextEdges,
            recordingNodeId: nextRecording,
            activeNodeUuid: nextActive,
            workbenchUuids: nextActive && !nextWorkbench.includes(nextActive)
              ? [nextActive, ...nextWorkbench].slice(0, WORKBENCH_SIZE)
              : nextWorkbench,
          })
        },

        focusRegionOnCanvas: (regionId) => {
          const state = get()
          const members = Object.values(state.nodes).filter(
            (candidate) => candidate.regionId === regionId && candidate.nodeType !== 'ghost-echo',
          )
          if (members.length === 0) return
          // Anchor preference: a live member (no wake cost), else pinned,
          // else the most recently visited — then issue the §B.5 fit request.
          const anchor =
            members.find((candidate) => candidate.ramState === 'live') ??
            members.find((candidate) => candidate.isPinned) ??
            [...members].sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)[0]
          set((current) => ({
            canvasFitRequest: { regionId, nonce: (current.canvasFitRequest?.nonce ?? 0) + 1 },
          }))
          get().activateNode(anchor.uuid)
          set({ viewMode: 'canvas' })
        },

        toggleAudible: (uuid) => {
          const node = get().nodes[uuid]
          if (!node) return
          const nextPaused = { ...get().audiblePausedAt }
          if (node.isAudible) {
            // Audio is pausing: start the §B.6 2.5 s immunity debounce so a
            // track gap never gets the tab hibernated mid-listen.
            nextPaused[uuid] = Date.now()
          } else {
            delete nextPaused[uuid]
          }
          set({
            nodes: { ...get().nodes, [uuid]: { ...node, isAudible: !node.isAudible } },
            audiblePausedAt: nextPaused,
          })
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
            trailFocusUuid: null,
            physicsFrozen: false,
            audiblePausedAt: {},
            canvasFitRequest: null,
            // `semanticZoomOverride` (the LOD lock) is deliberately NOT
            // cleared here: it is a user preference, not an ephemeral
            // glitch flag, and must survive canvas ⇄ reading round trips.
            nodes: Object.fromEntries(
              Object.entries(state.nodes).map(([id, node]) => [id, node.isLoading ? { ...node, isLoading: false } : node]),
            ),
          }))
        },

        restoreSessionHibernated: () => {
          set((state) => {
            const livePersisted = Object.values(state.nodes).some((node) => node.ramState === 'live' && node.nodeType !== 'ghost-echo')
            if (!livePersisted) return state
            return {
              nodes: Object.fromEntries(
                Object.entries(state.nodes).map(([id, node]) => {
                  if (node.ramState !== 'live' || node.nodeType === 'ghost-echo') return [id, node]
                  // The active anchor stays live: one warm center on the pill,
                  // one wake gesture resumes everything around it.
                  if (id === state.activeNodeUuid) return [id, node]
                  return [id, { ...node, ramState: 'hibernated', ramMb: 0, isLoading: false }]
                }),
              ),
            }
          })
        },

        setViewMode: (mode) => set({ viewMode: mode }),

        toggleCanvas: () => set((state) => ({ viewMode: state.viewMode === 'reading' ? 'canvas' : 'reading' })),

        setPaletteOpen: (open) => set({ paletteOpen: open }),
        togglePalette: () => set((state) => ({ paletteOpen: !state.paletteOpen })),
        setGlanceOpen: (open) => set({ glanceOpen: open }),
        toggleGlance: () => set((state) => ({ glanceOpen: !state.glanceOpen })),
        setTrailFocus: (uuid) => set({ trailFocusUuid: uuid }),
        toggleTrailFocus: (uuid) =>
          set((state) => ({ trailFocusUuid: state.trailFocusUuid === uuid ? null : uuid })),
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
        performanceGuardrail: state.performanceGuardrail,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return
        state.clearEphemeralFlags()
        // §B.6 startup restoration: persisted tabs boot HIBERNATED (0 MB,
        // cached WebPs in Stage 1/2) — the session's shape is restored, its
        // RAM is not. The active anchor stays live so the pill shows a warm
        // center and one clean wake gesture resumes the session. First run
        // stays 1 clean New Tab (no persisted state → nothing to restore).
        state.restoreSessionHibernated()
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

/** §B.4 elastic disclosure — every persisted node except ephemeral ghosts. */
export function selectTotalNodeCount(state: GraphStore): number {
  let count = 0
  for (const node of Object.values(state.nodes)) if (node.nodeType !== 'ghost-echo') count += 1
  return count
}

/**
 * §B.4 elastic disclosure — real tabs asleep in the 0 MB archive. Ephemeral
 * Ghost Echoes are predictions, not archive members: they surface through
 * the archive's Ghost Echoes chip and the canvas, and never force the
 * compact layout into the expanded deck.
 */
export function selectHibernatedCount(state: GraphStore): number {
  let count = 0
  for (const node of Object.values(state.nodes)) {
    if (node.nodeType === 'ghost-echo') continue
    if (node.ramState === 'hibernated') count += 1
  }
  return count
}

/**
 * §B.1 Smart Relational Dots — up to 6, WHY-driven, active node EXCLUDED
 * (the active tab is the pill's center trigger). Rank order: the page you
 * came from (came-from parent edge or `parentUuid`), loading children, live
 * siblings of the same link cluster, high-confidence Ghost Echoes
 * (materialized ghosts are ≥ 0.78 by construction), then the rest by edge
 * weight. Silent state grammar: filled = live, hollow = asleep, frosted
 * wash = Ghost Echo.
 */
export function selectPillNeighbours(state: GraphStore, uuid: NodeUuid): PillNeighborDot[] {
  const active = state.nodes[uuid]
  if (!active) return []
  const dotFor = (node: SpatialTabNodeRecord): PillNeighborDot['state'] =>
    node.nodeType === 'ghost-echo'
      ? 'ghost'
      : node.isLoading
        ? 'loading'
        : node.ramState === 'hibernated'
          ? 'hibernated'
          : 'live'
  const parent = active.parentUuid ? state.nodes[active.parentUuid] : null
  const neighbourEntries: Array<{
    node: SpatialTabNodeRecord
    weight: number
    cameFrom: boolean
    sibling: boolean
    viaSpawn: boolean
  }> = []
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
      viaSpawn: edgeRecord.kind === 'spawn',
    })
  }
  // The came-from parent may have no edge record (restored session) — make
  // sure it still anchors dot 1.
  if (parent && !neighbourEntries.some((entry) => entry.node.uuid === parent.uuid)) {
    neighbourEntries.push({ node: parent, weight: Number.MAX_SAFE_INTEGER / 2, cameFrom: true, sibling: false, viaSpawn: false })
  }
  neighbourEntries.sort((a, b) => {
    const rank = (entry: (typeof neighbourEntries)[number]): number => {
      if (entry.cameFrom) return 0
      if (entry.node.nodeType === 'ghost-echo') return 1
      if (entry.node.isLoading) return 2
      if (entry.sibling) return 3
      return 4
    }
    const rankDelta = rank(a) - rank(b)
    return rankDelta !== 0 ? rankDelta : b.weight - a.weight
  })
  const dots: PillNeighborDot[] = []
  for (const entry of neighbourEntries) {
    if (dots.length >= 6) break
    const node = entry.node
    let relationshipLabel: string
    let anchorDomain: string | null = null
    if (node.nodeType === 'ghost-echo') {
      relationshipLabel = `Ghost echo · ${Math.round((node.ghostMatch ?? 0) * 100)}%`
      anchorDomain = node.domain
    } else if (entry.cameFrom) {
      relationshipLabel = node.parentUuid === active.uuid ? 'Branched into' : `Branched from ${parent?.domain ?? node.domain}`
      anchorDomain = parent?.domain ?? node.domain
    } else if (entry.sibling) {
      relationshipLabel = `Sibling of ${parent?.domain ?? active.domain}`
      anchorDomain = parent?.domain ?? null
    } else {
      relationshipLabel = entry.viaSpawn ? 'Spawned alongside' : 'Visited alongside'
      anchorDomain = node.domain
    }
    dots.push({
      uuid: node.uuid,
      title: node.title,
      state: dotFor(node),
      relationshipLabel,
      anchorDomain,
      cameFrom: entry.cameFrom,
    })
  }
  return dots
}

/* ------------------------------------------------------------------ */
/* §B.5 Flows — non-exclusive rooted tab trees; notches + mini-trees    */
/* ------------------------------------------------------------------ */

function flowMembersOf(state: GraphStore, regionId: RegionId): SpatialTabNodeRecord[] {
  return Object.values(state.nodes).filter((node) => node.regionId === regionId && node.nodeType !== 'ghost-echo')
}

/**
 * §B.5 Satellite Flow Notches view-model. A flow is "active" when it holds
 * at least one live node or a pinned anchor (pinning replaces bookmarks).
 * The flow hosting the active node IS the main island — notches flank it
 * with the other active flows.
 */
export function selectFlowNotches(state: GraphStore): FlowNotch[] {
  const activeNode = state.activeNodeUuid ? state.nodes[state.activeNodeUuid] : null
  const notches: FlowNotch[] = []
  for (const region of selectRegionList(state)) {
    const members = flowMembersOf(state, region.id)
    if (members.length === 0) continue
    const liveCount = members.filter((member) => member.ramState === 'live').length
    const hasPinned = members.some((member) => member.isPinned)
    if (liveCount === 0 && !hasPinned) continue
    if (activeNode && region.id === activeNode.regionId) continue
    const anchor =
      members.find((member) => member.ramState === 'live') ??
      members.find((member) => member.isPinned) ??
      [...members].sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)[0]
    notches.push({
      regionId: region.id,
      name: region.name,
      color: region.color,
      nodeCount: members.length,
      liveCount,
      hasPinned,
      anchorUuid: anchor?.uuid ?? null,
    })
  }
  return notches
}

/** §B.5 mini-tree popover rows: the flow anchor + its branched children (depth 1). */
export function selectFlowTreeRows(state: GraphStore, regionId: RegionId): FlowTreeRow[] {
  const members = flowMembersOf(state, regionId)
  if (members.length === 0) return []
  const anchor =
    members.find((member) => member.ramState === 'live') ??
    members.find((member) => member.isPinned) ??
    [...members].sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)[0]
  if (!anchor) return []
  const rows: FlowTreeRow[] = [{ node: anchor, depth: 0 }]
  const children = members
    .filter((member) => member.parentUuid === anchor.uuid || (member.uuid !== anchor.uuid && member.parentUuid !== null && members.some((root) => root.uuid === member.parentUuid && root.parentUuid === null)))
    .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
  for (const child of children.slice(0, 7)) rows.push({ node: child, depth: 1 })
  return rows
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
 *
 * Phase 2 spatial core: tab scoring is batched through `lib/spatialCore`
 * (Rust WASM when ready, its exact-port TS mirror otherwise); notes and voice
 * memos keep the single-pair scorer, which both backends share bit-for-bit.
 * Snippet construction stays here (UI-only, as the Rust doc comment states).
 */
export function selectSearchResults(state: GraphStore, rawQuery: string, limit = 12): SearchResult[] {
  const query = rawQuery.trim().toLowerCase()
  if (!query) return []
  const results: SearchResult[] = []

  const docs: SearchDocCoreInput[] = []
  const nodeByUuid = new Map<NodeUuid, SpatialTabNodeRecord>()
  for (const node of Object.values(state.nodes)) {
    if (node.nodeType === 'ghost-echo') continue
    nodeByUuid.set(node.uuid, node)
    docs.push({
      uuid: node.uuid,
      title: node.title,
      domain: node.domain,
      url: node.url,
      searchQuery: node.searchQuery,
      keywords: node.keywords,
    })
  }
  for (const hit of batchFuzzySearch(query, docs, limit)) {
    const node = nodeByUuid.get(hit.uuid)
    if (!node) continue
    results.push({
      kind: 'tab',
      id: node.uuid,
      nodeId: node.uuid,
      noteId: null,
      memoId: null,
      title: node.title,
      snippet: `${node.domain} · ${node.ramState === 'live' ? 'Live tab' : isColdArchive(node, Date.now()) ? 'Cold archive' : 'Hibernated'}${hit.bestText ? ` — ${hit.bestText}` : ''}`,
      score: hit.score,
    })
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
