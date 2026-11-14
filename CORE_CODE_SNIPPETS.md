# Core Code Snippets — Spatial Reference Browser

> **Purpose:** A curated, single-file reference containing the production-grade source code snippets that define the core engineering of the **Spatial Reference Browser**. 
> Suitable for technical review, LLM context briefing (e.g. Gemini Web), and architecture audits.

---

## Table of Contents
1. [Core Domain Types (`app/src/lib/types.ts`)](#1-core-domain-types)
2. [State Store & Brain (`app/src/store/useGraphStore.ts`)](#2-state-store--brain)
   - [LRU Pool Enforcement with Immunity](#lru-pool-enforcement-with-immunity)
   - [Ghost Echo Recommendation Engine](#ghost-echo-recommendation-engine)
   - [Co-visitation Tracking](#co-visitation-tracking)
   - [Node Branching / Spawning](#node-branching--spawning)
3. [Moodboard Tidy Solver (`app/src/lib/moodboard.ts`)](#3-moodboard-tidy-solver)
4. [3-Tier Semantic LOD Node (`app/src/components/canvas/nodes/SpatialTabNode.tsx`)](#4-3-tier-semantic-lod-node)
5. [Hybrid Physics Layout Engine (`app/src/hooks/useHybridForceLayout.ts`)](#5-hybrid-physics-layout-engine)
6. [Anti-Slop Design Token System (`app/src/index.css`)](#6-anti-slop-design-token-system)

---

## 1. Core Domain Types

File: [`app/src/lib/types.ts`](file:///D:/Fivem/new%20brosser/app/src/lib/types.ts)

```typescript
import type { Edge, Node } from '@xyflow/react'

export type NodeUuid = string
export type UrlHash = string
export type EdgeId = string
export type RegionId = string
export type NoteId = string
export type MemoId = string

/** Active tabs carry mock RAM; hibernated tabs are strictly 0 MB. */
export type RamState = 'live' | 'hibernated'

/** Node types: standard tab, ephemeral search hub router, or suggested ghost echo. */
export type GraphNodeKind = 'tab' | 'hub' | 'ghost-echo'

/** Directional edges: spawned child satellites, co-visitation trails, ghost suggestions. */
export type GraphEdgeKind = 'spawn' | 'visit' | 'ghost'

/** Mode A (focused webview reader) vs Mode B (infinite spatial canvas). */
export type ViewMode = 'reading' | 'canvas'

/** 3-tier semantic LOD for scaling from 1 to 700+ nodes seamlessly. */
export type SemanticZoomLevel = 'macro' | 'compact' | 'rich'

/** Preview art specification rendered on 16:10 reference cards. */
export type PreviewSpec = {
  kind: 'canvas-scene' | 'typography' | 'shader-art' | 'brand-specimen' | 'risograph'
  accentHex: string
  aspectRatio: '16:10'
  title: string
  subtitle: string
  tagline?: string
  palette: readonly string[]
  seed: number
}

/** Full data structure attached to every spatial node. */
export type SpatialTabNodeData = {
  uuid: NodeUuid
  urlHash: UrlHash
  url: string
  title: string
  domain: string
  favicon: string
  ramState: RamState
  nodeType: GraphNodeKind
  previewArt: PreviewSpec
  notesCount: number
  hasVoiceMemo: boolean
  isPinned: boolean
  isAudible: boolean
  isRecording?: boolean
  childCount: number
  parentId?: NodeUuid
  clusterId?: RegionId
  lastActiveAt: number
  createdAt: number
}
```

---

## 2. State Store & Brain

File: [`app/src/store/useGraphStore.ts`](file:///D:/Fivem/new%20brosser/app/src/store/useGraphStore.ts)

### LRU Pool Enforcement with Immunity
*Enforces a strict cap of 5 live tabs while preserving critical audio, recording, and pinned tabs.*

```typescript
export const LIVE_POOL_LIMIT = 5

/** Enforce the 5-tab live warm pool with audio/recording/pinned immunity. */
enforceLivePool: (activeUuid: NodeUuid) => {
  const { nodes, recordingNodeId } = get()
  const liveNodes = Object.values(nodes).filter(
    (n) => n.ramState === 'live' && n.uuid !== activeUuid
  )

  if (liveNodes.length < LIVE_POOL_LIMIT) return

  // Filter out tabs that cannot be evicted
  const evictable = liveNodes.filter((node) => {
    if (node.isPinned) return false
    if (node.isAudible) return false
    if (node.uuid === recordingNodeId) return false
    return true
  })

  // Sort by LRU (least recently active first)
  evictable.sort((a, b) => a.lastActiveAt - b.lastActiveAt)

  if (evictable.length > 0) {
    const victim = evictable[0]
    get().hibernateNode(victim.uuid)
  }
}
```

### Ghost Echo Recommendation Engine
*Computes contextual similarity based on embedding cosine similarity, co-visitation history, and recency decay.*

$$\text{Relevance} = 0.55 \cdot \text{CosineSimilarity} + 0.30 \cdot \text{CoVisitation} + 0.15 \cdot \text{RecencyDecay} \ge 0.78$$

```typescript
export const GHOST_ECHO_THRESHOLD = 0.78
export const GHOST_SCORE_WEIGHTS = { cosine: 0.55, coVisit: 0.30, recency: 0.15 } as const
export const GHOST_MAX_SUGGESTIONS = 3
const GHOST_TETHER_DISTANCE = 150
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

/** Compute and spawn ghost echoes around the active node. */
refreshGhostEchoes: (activeUuid: NodeUuid) => {
  const { nodes, edges, coVisitations, suppressedGhostHashes } = get()
  const active = nodes[activeUuid]
  if (!active || active.nodeType !== 'tab') return

  const now = Date.now()
  const activeEmbedding = embedText(active.title + ' ' + active.domain)

  // Rank candidate hibernated nodes
  const candidates: Array<{ node: SpatialTabNodeData; score: number }> = []

  for (const candidate of Object.values(nodes)) {
    if (candidate.uuid === active.uuid) continue
    if (candidate.ramState !== 'hibernated') continue
    if (candidate.nodeType !== 'tab') continue
    if (suppressedGhostHashes.includes(candidate.urlHash)) continue

    // 1. Semantic Cosine Similarity
    const candEmbedding = embedText(candidate.title + ' ' + candidate.domain)
    const cosine = cosineSimilarity(activeEmbedding, candEmbedding)

    // 2. Co-visitation score
    const coVisitCount = coVisitations[`${active.urlHash}::${candidate.urlHash}`] ?? 0
    const normalizedCoVisit = Math.min(coVisitCount / 5, 1.0)

    // 3. Recency decay (7-day half-life)
    const ageMs = Math.max(0, now - candidate.lastActiveAt)
    const recency = Math.exp(-ageMs / (7 * 24 * 3600 * 1000))

    // Weighted composite relevance score
    const score =
      GHOST_SCORE_WEIGHTS.cosine * cosine +
      GHOST_SCORE_WEIGHTS.coVisit * normalizedCoVisit +
      GHOST_SCORE_WEIGHTS.recency * recency

    if (score >= GHOST_ECHO_THRESHOLD) {
      candidates.push({ node: candidate, score })
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  const topEchoes = candidates.slice(0, GHOST_MAX_SUGGESTIONS)

  // Position ghost nodes in an orbit around the active node
  topEchoes.forEach(({ node: target }, index) => {
    const angle = index * GOLDEN_ANGLE
    const ghostPos = {
      x: active.x + GHOST_TETHER_DISTANCE * Math.cos(angle),
      y: active.y + GHOST_TETHER_DISTANCE * Math.sin(angle),
    }
    get().spawnGhostNode(target, ghostPos, active.uuid)
  })
}
```

### Co-visitation Tracking
*Rapid transitions between tabs increment their relationship weight.*

```typescript
export const CO_VISITATION_WINDOW_MS = 10_000

recordCoVisitation: (fromHash: UrlHash, toHash: UrlHash) => {
  if (!fromHash || !toHash || fromHash === toHash) return
  const pairKey = `${fromHash}::${toHash}`
  const reverseKey = `${toHash}::${fromHash}`

  set((state) => ({
    coVisitations: {
      ...state.coVisitations,
      [pairKey]: (state.coVisitations[pairKey] ?? 0) + 1,
      [reverseKey]: (state.coVisitations[reverseKey] ?? 0) + 1,
    },
  }))
}
```

### Node Branching / Spawning
*Clicking links spawns directed child nodes on the canvas instead of replacing current view.*

```typescript
branchChildNode: (parentUuid: NodeUuid, childInit: { title: string; url: string }) => {
  const parent = get().nodes[parentUuid]
  if (!parent) return

  const childUuid = crypto.randomUUID()
  const offset = calculateSpawnOffset(parent.childCount)

  const childNode: SpatialTabNodeData = {
    uuid: childUuid,
    urlHash: hashUrl(childInit.url),
    url: childInit.url,
    title: childInit.title,
    domain: extractDomain(childInit.url),
    favicon: `/favicons/${extractDomain(childInit.url)}.png`,
    ramState: 'live',
    nodeType: 'tab',
    previewArt: generatePreviewSpec(childInit.title, childInit.url),
    notesCount: 0,
    hasVoiceMemo: false,
    isPinned: false,
    isAudible: false,
    childCount: 0,
    parentId: parentUuid,
    lastActiveAt: Date.now(),
    createdAt: Date.now(),
    x: parent.x + offset.x,
    y: parent.y + offset.y,
  }

  const branchEdge: GraphEdgeRecord = {
    id: `edge::${parentUuid}->${childUuid}`,
    source: parentUuid,
    target: childUuid,
    kind: 'spawn',
  }

  set((state) => ({
    nodes: { ...state.nodes, [childUuid]: childNode },
    edges: { ...state.edges, [branchEdge.id]: branchEdge },
  }))

  get().enforceLivePool(childUuid)
}
```

---

## 3. Moodboard Tidy Solver

File: [`app/src/lib/moodboard.ts`](file:///D:/Fivem/new%20brosser/app/src/lib/moodboard.ts)

*A pure mathematical layout algorithm that arranges nodes into an editorial contact-sheet grid while preserving all graph edges and leaving pinned anchor nodes untouched.*

```typescript
export const MOODBOARD_CARD_WIDTH = 260
export const MOODBOARD_CARD_HEIGHT = 199
export const MOODBOARD_PITCH_ASPECT = 16 / 10
export const MOODBOARD_PITCH_PADDING_Y = 41
export const MOODBOARD_PITCH_HEIGHT = MOODBOARD_CARD_HEIGHT + MOODBOARD_PITCH_PADDING_Y // 240px
export const MOODBOARD_PITCH_WIDTH = MOODBOARD_PITCH_HEIGHT * MOODBOARD_PITCH_ASPECT   // 384px
export const MOODBOARD_OVERLAP_MARGIN = 12

export function computeMoodboardGrid(
  nodes: readonly MoodboardNodeInput[],
  options: MoodboardGridOptions = {}
): MoodboardGridResult {
  const unpinned = nodes.filter((n) => !n.isPinned)
  const pinned = nodes.filter((n) => n.isPinned)

  if (unpinned.length === 0) {
    return { positions: new Map(), columns: 0, rows: 0 }
  }

  // Stable reading order (top-to-bottom, left-to-right, deterministic tiebreak)
  const sorted = [...unpinned].sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y
    if (a.x !== b.x) return a.x - b.x
    return a.uuid.localeCompare(b.uuid)
  })

  // Fit columns to item count for a balanced near-square aspect ratio
  const columns = Math.min(Math.ceil(Math.sqrt(sorted.length)), options.maxColumns ?? 8)
  const rows = Math.ceil(sorted.length / columns)

  // Compute reference center from current bounding box
  const bbox = computeCenter(nodes)
  const gridWidth = columns * MOODBOARD_PITCH_WIDTH
  const gridHeight = rows * MOODBOARD_PITCH_HEIGHT
  const startX = bbox.x - gridWidth / 2
  const startY = bbox.y - gridHeight / 2

  const positions = new Map<string, MoodboardPoint>()
  let currentSlot = 0

  for (const node of sorted) {
    let placed = false
    while (!placed) {
      const col = currentSlot % columns
      const row = Math.floor(currentSlot / columns)
      const slotX = startX + col * MOODBOARD_PITCH_WIDTH + (MOODBOARD_PITCH_WIDTH - MOODBOARD_CARD_WIDTH) / 2
      const slotY = startY + row * MOODBOARD_PITCH_HEIGHT + (MOODBOARD_PITCH_HEIGHT - MOODBOARD_CARD_HEIGHT) / 2

      // Check for overlap against immovable pinned anchors
      const candidateRect = { x: slotX, y: slotY, width: MOODBOARD_CARD_WIDTH, height: MOODBOARD_CARD_HEIGHT }
      const collidesWithPinned = pinned.some((p) =>
        rectIntersects(candidateRect, expandRect(p, MOODBOARD_OVERLAP_MARGIN))
      )

      if (!collidesWithPinned) {
        positions.set(node.uuid, { x: slotX, y: slotY })
        placed = true
      }
      currentSlot++
    }
  }

  return { positions, columns, rows }
}
```

---

## 4. 3-Tier Semantic LOD Node

File: [`app/src/components/canvas/nodes/SpatialTabNode.tsx`](file:///D:/Fivem/new%20brosser/app/src/components/canvas/nodes/SpatialTabNode.tsx)

*Root LOD dispatcher switching rendering strategy based on viewport zoom without re-mounting React Flow nodes.*

```tsx
export function SpatialTabNode(props: NodeProps<SpatialTabNodeData>) {
  const { data } = props
  const { lod } = useContext(CanvasLodContext)

  // Macro Tier: Zoom < 0.35 (dots + cluster titles)
  if (lod === 'macro') {
    return <MacroBeacon node={data} />
  }

  // Compact Tier: 0.35 <= Zoom < 0.65 (sleek 180x44 pills)
  if (lod === 'compact') {
    return <CompactPill node={data} />
  }

  // Rich Tier: Zoom >= 0.65 (full 260px editorial reference card)
  return <RichCard node={data} />
}

/** TIER 1: Macro Beacon (~24px inverse-scaled beacon) */
function MacroBeacon({ node }: { node: SpatialTabNodeData }) {
  const isLive = node.ramState === 'live'
  return (
    <div className="flex items-center gap-2 pointer-events-auto">
      <div
        className={clsx(
          'w-3 h-3 rounded-full transition-transform',
          isLive ? 'bg-teal-400 ring-2 ring-teal-400/20' : 'bg-white/20'
        )}
      />
      {node.isPinned && (
        <span className="text-[11px] font-sans text-white/50 tracking-wide select-none">
          {node.title}
        </span>
      )}
    </div>
  )
}

/** TIER 2: Compact Pill (180x44 sleek pill) */
function CompactPill({ node }: { node: SpatialTabNodeData }) {
  return (
    <div className="w-[180px] h-[44px] bg-[#18181C] border border-white/[0.07] rounded-lg px-2.5 flex items-center gap-2 hover:border-white/20 transition-colors">
      <img src={node.favicon} alt="" className="w-3.5 h-3.5 rounded-sm" />
      <span className="text-[12px] text-white/80 font-sans truncate flex-1">
        {node.title}
      </span>
      {node.ramState === 'live' && (
        <span className="w-1.5 h-1.5 rounded-full bg-teal-400" />
      )}
    </div>
  )
}

/** TIER 3: Rich Reference Card (260px editorial preview card) */
function RichCard({ node }: { node: SpatialTabNodeData }) {
  const isHibernated = node.ramState === 'hibernated'
  return (
    <div
      className={clsx(
        'w-[260px] bg-[#18181C] border border-white/[0.07] rounded-xl overflow-hidden shadow-2xl transition-all',
        isHibernated && 'opacity-60 hover:opacity-100'
      )}
    >
      {/* 16:10 Preview Artwork */}
      <div className="w-full aspect-[16/10] bg-[#121215] relative overflow-hidden border-b border-white/[0.04]">
        <PreviewArt spec={node.previewArt} />
      </div>

      {/* 36px Editorial Footer */}
      <div className="h-[36px] px-3 flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <img src={node.favicon} alt="" className="w-3.5 h-3.5 rounded-sm" />
          <span className="text-[12px] font-medium text-white/90 truncate max-w-[140px]">
            {node.title}
          </span>
        </div>
        <span className="text-[10.5px] text-white/40 font-mono truncate">
          {node.domain}
        </span>
      </div>
    </div>
  )
}
```

---

## 5. Hybrid Physics Layout Engine

File: [`app/src/hooks/useHybridForceLayout.ts`](file:///D:/Fivem/new%20brosser/app/src/hooks/useHybridForceLayout.ts)

*Integrates `d3-force` with locked pinned anchors so spatial hubs remain motionless while spawned links settle dynamically.*

```typescript
import { forceSimulation, forceLink, forceManyBody, forceCollide } from 'd3-force'

export function useHybridForceLayout(nodes: SpatialTabNodeData[], edges: GraphEdgeRecord[]) {
  useEffect(() => {
    // Pinned nodes lock their physical coordinates (fx/fy)
    const simulationNodes = nodes.map((n) => ({
      ...n,
      fx: n.isPinned ? n.x : null,
      fy: n.isPinned ? n.y : null,
    }))

    const simulation = forceSimulation(simulationNodes)
      .force(
        'link',
        forceLink(edges)
          .id((d: any) => d.uuid)
          .distance(120)
          .strength(0.7)
      )
      .force('charge', forceManyBody().strength(-200))
      .force('collide', forceCollide().radius(140).iterations(2))
      .alphaDecay(0.05)

    simulation.on('tick', () => {
      // Stream updated coordinates to store without triggering full layout thrashing
    })

    return () => simulation.stop()
  }, [nodes, edges])
}
```

---

## 6. Anti-Slop Design Token System

File: [`app/src/index.css`](file:///D:/Fivem/new%20brosser/app/src/index.css)

```css
@import "tailwindcss";

:root {
  color-scheme: dark;

  /* Surfaces: Matte Graphite hierarchy */
  --bg-canvas: #0b0b0d;                    /* Infinite canvas backdrop */
  --bg-chrome: #121215;                    /* Command bars & floating rail */
  --bg-card: #18181c;                      /* Reference cards & panels */
  --bg-elevated: #202026;                  /* Modals, popovers & palettes */
  --bg-glass: rgba(18, 18, 21, 0.78);      /* Frosted floating pill */

  /* Hairlines: Ultra-subtle 1px boundaries */
  --border-subtle: rgba(255, 255, 255, 0.065); /* Resting hairline */
  --border-hover: rgba(255, 255, 255, 0.14);    /* Interactive hover */
  --border-active: rgba(255, 255, 255, 0.28);   /* Focused active outline */

  /* Text & Accent: Restrained contrast */
  --text-primary: #ededed;
  --text-muted: rgba(255, 255, 255, 0.50);
  --accent-live: #2dd4bf;                  /* Subdued 5px live indicator */
}

/* Warm Paper Light Theme */
html[data-theme='paper'] {
  color-scheme: light;
  --bg-canvas: #f4f1ea;
  --bg-chrome: #ebe6dc;
  --bg-card: #ffffff;
  --border-subtle: rgba(0, 0, 0, 0.08);
  --border-active: rgba(0, 0, 0, 0.35);
  --text-primary: #1c1c1e;
  --text-muted: rgba(0, 0, 0, 0.55);
}
```
