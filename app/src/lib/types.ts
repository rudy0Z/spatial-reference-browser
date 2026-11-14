/**
 * app/src/lib/types.ts — shared domain model + component prop contracts.
 *
 * Every type the five component builders compile against lives here
 * (SPEC.md §1 file structure, §4 node card spec, §6 founder addenda,
 * §7 edge cases, §8 substitutions).
 *
 * NOTE: `SpatialTabNodeData` and friends are declared with `type` aliases
 * (not `interface`) because @xyflow/react v12 constrains node data to
 * `Record<string, unknown>` and only type aliases get implicit index
 * signatures.
 */
import type { Edge, Node, NodeProps } from '@xyflow/react'
import { fnv1a32 } from './embed'

/* ------------------------------------------------------------------ */
/* Identifier aliases                                                  */
/* ------------------------------------------------------------------ */

export type NodeUuid = string
export type UrlHash = string
export type EdgeId = string
export type RegionId = string
export type NoteId = string
export type MemoId = string

/* ------------------------------------------------------------------ */
/* Core enums (plain unions — `erasableSyntaxOnly` forbids TS enums)   */
/* ------------------------------------------------------------------ */

/** §4 states 1 & 2 — live tabs carry mock RAM; hibernated is always 0 MB (§8). */
export type RamState = 'live' | 'hibernated'

/** §7.1 — `hub` = ephemeral google.com search router; §4 state 3 = `ghost-echo`. */
export type GraphNodeKind = 'tab' | 'hub' | 'ghost-echo'

/** §4.6 — directional edges: spawned satellites, traversal co-visitation, ghost tethers. */
export type GraphEdgeKind = 'spawn' | 'visit' | 'ghost'

/** §3 — Mode A reading viewport vs Mode B spatial canvas. */
export type ViewMode = 'reading' | 'canvas'

/** §4 semantic zoom levels (LOD for the 600-node stress test). */
export type SemanticZoomLevel = 'macro' | 'compact' | 'rich'

/** §6 neighbor-dot semantics on the Floating Island Pill (max 6 dots). */
export type PillNeighborDotState = 'active' | 'loading' | 'live' | 'hibernated' | 'ghost'

/* ------------------------------------------------------------------ */
/* Phase 1.5 — deterministic preview specs                             */
/* ------------------------------------------------------------------ */

/**
 * Phase 1.5 — which deterministic preview render a reference card shows.
 * The UI chrome is dead-neutral; these preview renders are where 100%
 * of the color lives (ZCODE_MASTER_PROMPT.md §Phase 1.5).
 */
export type PreviewSpecKind =
  | 'type-specimen'
  | 'ui-grid'
  | 'duotone'
  | 'wireframe'
  | 'swatch-board'
  | 'logo-mark'

/**
 * Declarative directive for a node's preview artwork, persisted per node
 * (optional — pre-1.5 persisted state has no `preview` field).
 * `ink`/`paper` are optional CSS color overrides for duotone-style
 * treatments; when absent consumers fall back to the neutral ink/paper
 * tokens. `seed` must always drive the artwork — never Math.random(),
 * never per-render variation.
 */
export type PreviewSpec = {
  kind: PreviewSpecKind
  /** Deterministic generator seed — stable per node, never per render. */
  seed: number
  /** Optional ink override (any CSS color); default = neutral ink token. */
  ink?: string
  /** Optional paper override (any CSS color); default = neutral paper token. */
  paper?: string
}

/* ------------------------------------------------------------------ */
/* Domain records                                                      */
/* ------------------------------------------------------------------ */

export type SubPageRef = {
  /** Label of the in-domain pushState trail entry (§7.3 filmstrip). */
  title: string
  url: string
}

/**
 * One spatial tab node — the single persisted record keyed by `node_uuid`.
 * `url_hash` is the canonical identity derived from the URL (§7.6):
 * two nodes may share a `url_hash`; sticky notes attach to it so they
 * appear on every duplicate instance automatically.
 */
export type SpatialTabNodeRecord = {
  /** `node_uuid` — unique per instance (never reused). */
  uuid: NodeUuid
  /** `url_hash` — canonical URL identity, shared by duplicates (§7.6). */
  urlHash: UrlHash
  url: string
  domain: string
  title: string
  /** §6 — named spatial island ("UI Inspiration", "Job Hunt", …); null = unregioned. */
  regionId: RegionId | null
  nodeType: GraphNodeKind
  ramState: RamState
  /** Mock RAM number, stable per tab; 0 whenever hibernated (§8). */
  ramMb: number
  /** §5.3 — mock "playing audio" toggle; immune from auto-hibernation. */
  isAudible: boolean
  /** §4.6 — pinned anchor: `(fx, fy)` locked so physics never drifts it. */
  isPinned: boolean
  /** §6 — pulsing pill dot; true while a navigation is simulated. */
  isLoading: boolean
  /** §7.4 — private/sensitive: render blur-glass placeholder, never a thumbnail. */
  noCapture: boolean
  /** §7.1 — ephemeral utility router (google.com search hub). */
  ephemeral: boolean
  /** §7.2 — navigation chains <3s or oauth/payment domains collapsed into ONE node. */
  viaAuth: boolean
  /** §7.1 — subtle search-query pill tag on hub destination nodes. */
  searchQuery: string | null
  /** §7.3 — in-domain pushState trail rendered as an expandable filmstrip. */
  subPages: SubPageRef[]
  /** §7.5 — Readability-style markdown snapshot for dead links ("cached text"). */
  excerpt: string | null
  /** Extra corpus keywords feeding the Ghost Echo embedder + palette search. */
  keywords: string[]
  /** Parent this satellite was spawned from (§4.6 radial positioning). */
  parentUuid: NodeUuid | null
  /** For `ghost-echo` nodes: the hibernated node this echo predicts. */
  ghostOfUuid: NodeUuid | null
  /** For `ghost-echo` nodes: the active node it is tethered beside. */
  ghostTetherUuid: NodeUuid | null
  /** For `ghost-echo` nodes: match score 0..1 rendered as `92% MATCH`. */
  ghostMatch: number | null
  /**
   * False only for freshly spawned satellites still being placed by the
   * hybrid force layout; once settled their position is committed and they
   * are never auto-moved again (§6 "never auto-move existing nodes").
   */
  settled: boolean
  visitCount: number
  /** Recency clock for decay (§4.2), ghost recency (§6) and the LRU pool (§5.2). */
  lastVisitedAt: number
  createdAt: number
  /** Persisted canvas position. */
  x: number
  y: number
  /** Persisted anchor lock — non-null iff `isPinned`. */
  fx: number | null
  fy: number | null
  /**
   * Phase 1.5 — optional persisted preview directive. Absent in all
   * pre-1.5 persisted state, so old stores still load unchanged;
   * consumers MUST fall back to `defaultPreviewSpecFor(node)`
   * (deterministic from domain + uuid), never to a random value.
   */
  preview?: PreviewSpec
}

/** Directional edge between two nodes; id is `${source}->${target}`. */
export type GraphEdgeRecord = {
  id: EdgeId
  source: NodeUuid
  target: NodeUuid
  /** Co-visitation weight — switching A→B within 10s increments it (§6). */
  weight: number
  kind: GraphEdgeKind
  createdAt: number
}

/** §6 — regions replace workspaces: named spatial islands with a color. */
export type Region = {
  id: RegionId
  name: string
  color: string
  center: { x: number; y: number }
  radius: number
  createdAt: number
}

/**
 * §7.6 — sticky notes attach to `url_hash`, NOT `node_uuid`, so they show
 * on every duplicate instance of the same page automatically.
 */
export type StickyNote = {
  id: NoteId
  urlHash: UrlHash
  text: string
  createdAt: number
  updatedAt: number
}

/**
 * §4.4 voice memo — `audioSrc` is a `data:` URL (survives zustand persist)
 * or a runtime `blob:` URL. Real WebM/Opus from MediaRecorder (§1, §8).
 */
export type VoiceMemo = {
  id: MemoId
  nodeId: NodeUuid
  title: string
  durationMs: number
  audioSrc: string
  createdAt: number
}

/* ------------------------------------------------------------------ */
/* Derived / view-model types                                          */
/* ------------------------------------------------------------------ */

/** §6 — one pill dot: accent=active, pulsing=loading, hollow=hibernated, violet=ghost. */
export type PillNeighborDot = {
  uuid: NodeUuid
  title: string
  state: PillNeighborDotState
}

/** One hop level of the neighbourhood BFS (§3 Neighbourhood Glance). */
export type NeighbourhoodEntry = {
  node: SpatialTabNodeRecord
  depth: 1 | 2
}

/** Result of the 1-hop/2-hop BFS used by the pill and the glance panel. */
export type NeighbourhoodResult = {
  nodes: NeighbourhoodEntry[]
  edges: GraphEdgeRecord[]
}

/** §6 Ghost Echo score breakdown — `relevance = 0.55·cosine + 0.30·coVisit + 0.15·recency`. */
export type GhostEchoScoreBreakdown = {
  cosine: number
  coVisit: number
  recency: number
  relevance: number
}

/** A scored Ghost Echo candidate (before it is materialized as a ghost node). */
export type GhostEchoCandidate = {
  node: SpatialTabNodeRecord
} & GhostEchoScoreBreakdown

/** §5.2 — pool eviction surfaced so the UI can toast it. */
export type EvictionNotice = {
  uuid: NodeUuid
  title: string
  at: number
  reason: 'pool-limit'
}

/** §3 palette fuzzy search across tabs, hibernated nodes, notes, voice-note titles. */
export type SearchResultKind = 'tab' | 'note' | 'memo'

export type SearchResult = {
  kind: SearchResultKind
  /** Primary id: node uuid, note id or memo id. */
  id: string
  nodeId: NodeUuid | null
  noteId: NoteId | null
  memoId: MemoId | null
  title: string
  snippet: string
  score: number
}

/** §5.1 — outbound link target emitted by the mock reader. */
export type MockLinkTarget = {
  url: string
  title: string
  searchQuery?: string
}

/** §6 drag-to-anchor payload — reader drag source ⇄ pill drop zone contract. */
export type SpatialDragPayload = {
  url: string
  title: string
  searchQuery?: string
}

/** MIME type both MockWebReader (drag source) and FloatingIslandPill (drop zone) agree on. */
export const SPATIAL_DRAG_MIME = 'application/x-spatial-tab-seed'

/** §3 slash commands rendered by the expanded palette. Per the Fresh-State
 * Browser Law (master spec §0.2) no test/stress generator is user-facing —
 * the 700-node fixture lives behind `window.__devStressSeed`. */
export type SlashCommandId = 'canvas' | 'hibernate-all' | 'new' | 'note' | 'cluster'

export type SlashCommand = {
  id: SlashCommandId
  label: string
  description: string
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: 'canvas', label: '/canvas', description: 'Toggle reading viewport ⇄ spatial canvas' },
  { id: 'hibernate-all', label: '/hibernate-all', description: 'Hibernate every non-immune live tab' },
  { id: 'new', label: '/new', description: 'Spawn a fresh live tab near the active node' },
  { id: 'note', label: '/note', description: 'Quick sticky note on the active node' },
  { id: 'cluster', label: '/cluster', description: 'Wrap the active 1-hop neighbourhood into a region' },
]

/* ------------------------------------------------------------------ */
/* Domain constants + pure helpers                                     */
/* ------------------------------------------------------------------ */

/** §4.2 — untouched > 14 simulated days dims into a "Cold Archive" chip. */
export const COLD_ARCHIVE_DAYS = 14

/** All preview kinds, in the fixed cycle order used by `defaultPreviewSpecFor`. */
export const PREVIEW_KINDS: readonly PreviewSpecKind[] = [
  'type-specimen',
  'ui-grid',
  'duotone',
  'wireframe',
  'swatch-board',
  'logo-mark',
]

/**
 * Deterministic fallback preview for nodes persisted before Phase 1.5
 * (no `preview` field). Derived purely from `${domain}:${uuid}` via
 * FNV-1a, so the same node renders the same preview on every machine,
 * in every session — old persisted state loads unchanged.
 */
export function defaultPreviewSpecFor(node: Pick<SpatialTabNodeRecord, 'uuid' | 'domain'>): PreviewSpec {
  const hash = fnv1a32(`${node.domain}:${node.uuid}`)
  return { kind: PREVIEW_KINDS[hash % PREVIEW_KINDS.length], seed: hash }
}

/** Region accent palette cycled by region/cluster creation — dead-neutral
 * architectural tones in the same family as the seed's designer islands
 * (the UI owns no hue; reference thumbnails own the color). */
export const REGION_COLORS: readonly string[] = [
  '#8E8E96', // cool slate gray
  '#B5B0A5', // warm stone
  '#6E6A61', // umber
  '#5A5A63', // deep slate
  '#9B968B', // paper taupe
  '#767B85', // blue-gray
]

const DAY_MS = 86_400_000

/**
 * Canonical URL identity: strips protocol/www/trailing slash/utm params so
 * mirror URLs collapse onto one `url_hash` (§7.6 duplicate-URL model).
 */
export function canonicalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '')
  try {
    const parsed = new URL(trimmed)
    parsed.hash = ''
    for (const junk of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ref', 'ref_src']) {
      parsed.searchParams.delete(junk)
    }
    const query = parsed.searchParams.toString()
    return (
      parsed.host.replace(/^www\./, '') +
      parsed.pathname.replace(/\/+$/, '') +
      (query ? `?${query}` : '')
    )
  } catch {
    return trimmed.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '')
  }
}

/** Canonical `url_hash` (deterministic FNV-1a over the canonical URL). */
export function urlHashOf(rawUrl: string): UrlHash {
  return `u${fnv1a32(canonicalizeUrl(rawUrl)).toString(16).padStart(8, '0')}`
}

/** Display domain (host without www; falls back to the text before the first slash). */
export function domainOf(rawUrl: string): string {
  try {
    return new URL(rawUrl.trim()).host.replace(/^www\./, '')
  } catch {
    const cleaned = rawUrl.trim().replace(/^[a-z]+:\/\//, '')
    return cleaned.split('/')[0] || 'unknown'
  }
}

/** §8 — mock RAM badge number, stable per tab: 48–220 MB derived from the uuid. */
export function ramMbFor(uuid: NodeUuid): number {
  return 48 + (fnv1a32(`ram:${uuid}`) % 173)
}

/** Mono badge fragment: `138 MB` / `0 MB`. */
export function formatRamMb(mb: number): string {
  return `${Math.max(0, Math.round(mb))} MB`
}

/** Voice memo duration chip: `0:12` (m:ss). */
export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

/** Floating-point day count between two timestamps. */
export function daysSince(from: number, now: number): number {
  return Math.max(0, (now - from) / DAY_MS)
}

/** §4.2 state 2 — hibernated node untouched for more than 14 simulated days. */
export function isColdArchive(node: SpatialTabNodeRecord, now: number): boolean {
  return node.ramState === 'hibernated' && daysSince(node.lastVisitedAt, now) > COLD_ARCHIVE_DAYS
}

/** §7.2 — oauth/payment/sign-in URLs collapse into one "via auth" node. */
export function looksLikeAuthOrPaymentUrl(rawUrl: string): boolean {
  return /(oauth|\/signin|\/login|\/sso\b|accounts\.google\.|appleid\.apple\.|login\.microsoft|paypal\.|checkout\.|\/billing|\/payment|pay\.stripe)/i.test(
    rawUrl,
  )
}

/**
 * §4 semantic zoom → LOD level. The LOD lock (`override`) pins the tier that
 * was current when it was engaged (`SemanticZoomLevel | null`, null = off):
 * while locked, the wheel keeps zooming but the tier holds; unlocking
 * resumes natural tier-stepping at the thresholds below.
 */
export function lodForZoom(zoom: number, override: SemanticZoomLevel | null): SemanticZoomLevel {
  if (override) return override
  if (zoom < 0.35) return 'macro'
  if (zoom < 0.65) return 'compact'
  return 'rich'
}

/* ------------------------------------------------------------------ */
/* Component prop contracts (the five builders implement these)        */
/* ------------------------------------------------------------------ */

/**
 * @xyflow/react custom-node data for `SpatialTabNode`. Built per render by
 * SpatialCanvas from the store record; everything the card renders is here
 * so the node component stays pure. The §4 semantic-zoom tier is NOT part
 * of the data — it flows through `CanvasLodContext`
 * (components/canvas/canvasLodContext.ts) so a tier crossing re-renders only
 * the mounted card components instead of rebuilding every React Flow node
 * object in the graph (the Phase 1.5 700-node freeze fix).
 */
export type SpatialTabNodeData = {
  /** The full domain record (never mutate it inside the component). */
  node: SpatialTabNodeRecord
  regionName: string | null
  regionColor: string | null
  isActive: boolean
  isWorkbench: boolean
  /** Sticky notes attached to this node's `url_hash`. */
  noteCount: number
  hasVoiceMemo: boolean
  /** Direct satellite children (for the `+N TABS` deck badge, §4.5). */
  childCount: number
  /** This parent's stack is currently collapsed (deck mode, §4.5). */
  isStackCollapsed: boolean
}

/** React Flow node shape for spatial tab cards. */
export type SpatialTabFlowNode = Node<SpatialTabNodeData, 'spatialTab'>

/** Contract for `src/components/canvas/nodes/SpatialTabNode.tsx`. */
export type SpatialTabNodeProps = NodeProps<SpatialTabFlowNode>

/** React Flow edge data (styling: spawn arrows, traversal pulses, ghost tethers). */
export type SpatialEdgeData = {
  kind: GraphEdgeKind
  weight: number
}

/** React Flow edge shape used on the canvas. */
export type SpatialFlowEdge = Edge<SpatialEdgeData>

/**
 * Contract for `src/components/chrome/FloatingIslandPill.tsx`.
 * Fully store-driven: it reads the active node, neighbour dots
 * (`selectPillNeighbours`), palette/glance flags and ghost dots from
 * `useGraphStore`, so the app shell composes it with no wiring props.
 */
export type FloatingIslandPillProps = {
  className?: string
}

/**
 * Contract for `src/components/chrome/NeighbourhoodGlance.tsx` — §3:
 * crisp 300px glass panel with 1-hop + 2-hop nodes and ghost suggestions.
 */
export type NeighbourhoodGlanceProps = {
  className?: string
  /** Panel width in px; default 300 per SPEC §3. */
  width?: number
}

/**
 * Contract for `src/components/canvas/SpatialCanvas.tsx`. Store-driven:
 * zoom/LOD, freeze toggle, workbench tray, collapse stacks and node
 * positions all flow through `useGraphStore` (+ `useHybridForceLayout`).
 */
export type SpatialCanvasProps = {
  className?: string
}

/**
 * Contract for `src/components/viewport/MockWebReader.tsx`.
 * `onNavigate` = normal click (navigate active node in place, §5.1);
 * `onBranch` = Cmd/Ctrl+Click or Branch button (spawn child satellite, §5.1).
 * Draggable artifacts must set `dataTransfer` with `SPATIAL_DRAG_MIME` +
 * a JSON `SpatialDragPayload` for the pill drop zone (§6).
 */
export type MockWebReaderProps = {
  node: SpatialTabNodeRecord
  onNavigate: (target: MockLinkTarget) => void
  onBranch: (target: MockLinkTarget) => void
  /** §7.3 — in-page pushState navigation; App wires this to `pushSubPage`. */
  onSubNavigate?: (sub: SubPageRef) => void
  className?: string
}
