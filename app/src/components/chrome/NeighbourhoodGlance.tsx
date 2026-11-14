/**
 * app/src/components/chrome/NeighbourhoodGlance.tsx — SPEC §3 "Local
 * Neighbourhood Glance" (Cmd/Ctrl+Shift+G): a crisp 300px dark-tactical-glass
 * panel that slides in beside the reading viewport and shows ONLY the active
 * node's 1-hop and 2-hop neighbours plus any active Ghost Echo suggestions,
 * as a small live force graph (SVG + the shared d3-force hook). Clicking any
 * node — in the graph or the compact list below it — focuses it on the
 * spatial canvas via the store's `focusNodeOnCanvas` action.
 *
 * Store-driven, like the Floating Island Pill: the panel gates itself on the
 * `glanceOpen` runtime flag (the shell only mounts it and positions it via
 * its own wrapper / `className`). Data comes from `selectNeighbourhood`
 * (§3 BFS, ghost tether edges included so suggestions surface) unioned with
 * `selectGhostEchoNodes` for ghosts tethered to the active node.
 *
 * §6 guardrail "never auto-move existing nodes": the mini-graph runs the
 * shared `useHybridForceLayout` hook with `onSettle` intentionally omitted,
 * so layout settling never commits positions back to the store — the glance
 * is a read-only lens. The active node is pinned at the panel centre via the
 * hook's `fx`/`fy` support; neighbours keep their real canvas bearings,
 * scaled + clamped into the small viewport. `physicsFrozen` freezes the
 * mini-graph too (§6 Freeze stops ALL motion).
 *
 * Design language (§2): `bg-surface-glass` + `backdrop-blur-xl`, hairline
 * borders, #34D399 accent for live signal, #A78BFA dashed violet for Ghost
 * Echoes, JetBrains Mono for badges/counts, framer-motion springs
 * (stiffness 380 / damping 30), lucide-react icons.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { MousePointerClick, Radar, X } from 'lucide-react'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { selectGhostEchoNodes, selectNeighbourhood, useGraphStore } from '../../store/useGraphStore'
import { useHybridForceLayout } from '../../hooks/useHybridForceLayout'
import type {
  LayoutLinkInput,
  LayoutNodeInput,
  LayoutPosition,
  LayoutPositions,
} from '../../hooks/useHybridForceLayout'
import { formatRamMb } from '../../lib/types'
import type {
  GraphEdgeKind,
  NeighbourhoodGlanceProps,
  NeighbourhoodResult,
  NodeUuid,
  SpatialTabNodeRecord,
} from '../../lib/types'

/* ------------------------------------------------------------------ */
/* Local styling helper (no shared cn module exists yet — see report)  */
/* ------------------------------------------------------------------ */

function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** §2 motion language — snappy springs, zero linear easing. */
const GLANCE_SPRING = { type: 'spring', stiffness: 380, damping: 30 } as const

/** Mini-graph canvas height inside the panel (px). */
const GLANCE_GRAPH_HEIGHT = 252

/** Keep every mini-graph home at least this far from the SVG border (px). */
const GRAPH_EDGE_INSET = 20

/** Stable empty result so closed/empty states never churn identities. */
const EMPTY_NEIGHBOURHOOD: NeighbourhoodResult = { nodes: [], edges: [] }

/** Scoped keyframes + scrollbar styling for this panel only. */
const GLANCE_STYLES = `
@keyframes glance-pulse-opacity {
  0%, 100% { opacity: 0.9; }
  50% { opacity: 0.15; }
}
.glance-pulse-ring { animation: glance-pulse-opacity 2.4s ease-in-out infinite; }
.glance-loading-blink { animation: glance-pulse-opacity 0.9s ease-in-out infinite; }
.glance-scroll { scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.14) transparent; }
.glance-scroll::-webkit-scrollbar { width: 5px; }
.glance-scroll::-webkit-scrollbar-track { background: transparent; }
.glance-scroll::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.12); border-radius: 999px; }
`

/* ------------------------------------------------------------------ */
/* View-model types (read-only projections of the store records)       */
/* ------------------------------------------------------------------ */

/** One dot in the glance graph/list: a BFS neighbour or a Ghost Echo. */
type GlanceEntry = {
  node: SpatialTabNodeRecord
  depth: 1 | 2
  isGhost: boolean
}

/** One tether in the mini-graph (real edge, or synthesized ghost tether). */
type GlanceEdge = {
  id: string
  source: NodeUuid
  target: NodeUuid
  kind: GraphEdgeKind
  weight: number
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function truncateLabel(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text
}

/**
 * Mini-graph home positions: the active node pinned dead-centre, neighbours
 * mapped from their REAL canvas offsets so the glance preserves true spatial
 * bearings (bird's-eye recall, §6). Spread is clamped so both a tight local
 * cluster and a 5000px-apart outlier stay legible inside the small viewport.
 */
function computeGlanceHomes(
  active: SpatialTabNodeRecord,
  entries: GlanceEntry[],
  width: number,
  height: number,
): Record<NodeUuid, LayoutPosition> {
  const centerX = width / 2
  const centerY = height / 2
  const homes: Record<NodeUuid, LayoutPosition> = { [active.uuid]: { x: centerX, y: centerY } }
  let maxDist = 0
  for (const entry of entries) {
    maxDist = Math.max(maxDist, Math.hypot(entry.node.x - active.x, entry.node.y - active.y))
  }
  const spread = Math.min(2600, Math.max(150, maxDist))
  const fitRadius = Math.min(width, height) / 2 - GRAPH_EDGE_INSET
  const scale = fitRadius / spread
  for (const entry of entries) {
    homes[entry.node.uuid] = {
      x: clamp(centerX + (entry.node.x - active.x) * scale, GRAPH_EDGE_INSET, width - GRAPH_EDGE_INSET),
      y: clamp(centerY + (entry.node.y - active.y) * scale, GRAPH_EDGE_INSET, height - GRAPH_EDGE_INSET),
    }
  }
  return homes
}

/** §2/§4 palette for mini-graph nodes (active node is styled inline). */
function glanceNodeVisual(entry: GlanceEntry, hovered: boolean): {
  radius: number
  fill: string
  stroke: string
  strokeWidth: number
  dashed: boolean
} {
  const node = entry.node
  if (entry.isGhost) {
    // §4 state 3 — spectral violet, dashed glowing border.
    return { radius: 6.5, fill: 'rgba(167, 139, 250, 0.16)', stroke: '#A78BFA', strokeWidth: hovered ? 2 : 1.25, dashed: true }
  }
  if (node.nodeType === 'hub') {
    // §7.1 — ephemeral google.com routers render as neutral chips.
    return { radius: 5, fill: 'rgba(148, 163, 184, 0.2)', stroke: 'rgba(148, 163, 184, 0.65)', strokeWidth: hovered ? 1.75 : 1.1, dashed: false }
  }
  if (node.isLoading) {
    // §6 pill dot semantics — pulsing = loading.
    return { radius: 7, fill: 'rgba(52, 211, 153, 0.28)', stroke: '#34D399', strokeWidth: hovered ? 2 : 1.4, dashed: false }
  }
  if (node.ramState === 'hibernated') {
    // §6 pill dot semantics — hollow = hibernated.
    return {
      radius: entry.depth === 1 ? 6 : 4.5,
      fill: 'rgba(148, 163, 184, 0.1)',
      stroke: 'rgba(203, 213, 225, 0.45)',
      strokeWidth: hovered ? 1.75 : 1.1,
      dashed: false,
    }
  }
  return {
    radius: entry.depth === 1 ? 7 : 5.5,
    fill: 'rgba(52, 211, 153, 0.2)',
    stroke: 'rgba(52, 211, 153, 0.85)',
    strokeWidth: hovered ? 2 : 1.3,
    dashed: false,
  }
}

/** Edge styling by kind (§4.6): ghost tethers dashed violet, spawn brighter. */
function glanceEdgeVisual(edge: GlanceEdge, highlighted: boolean): {
  stroke: string
  width: number
  dasharray?: string
} {
  if (edge.kind === 'ghost') {
    return { stroke: highlighted ? 'rgba(167, 139, 250, 0.85)' : 'rgba(167, 139, 250, 0.45)', width: 1, dasharray: '3 3' }
  }
  if (edge.kind === 'spawn') {
    return {
      stroke: highlighted ? 'rgba(110, 231, 183, 0.7)' : 'rgba(255, 255, 255, 0.18)',
      width: 1 + Math.min(1.5, edge.weight * 0.15),
    }
  }
  return {
    stroke: highlighted ? 'rgba(110, 231, 183, 0.6)' : 'rgba(255, 255, 255, 0.1)',
    width: 1 + Math.min(1.2, edge.weight * 0.12),
  }
}

/** §6 dot semantics for the list rows: violet ghost, pulsing loading, hollow hibernated. */
function rowDotStyle(entry: GlanceEntry): CSSProperties {
  const node = entry.node
  if (entry.isGhost) return { background: 'rgba(167, 139, 250, 0.95)', boxShadow: '0 0 7px rgba(167, 139, 250, 0.6)' }
  if (node.isLoading) return { background: '#34D399', boxShadow: '0 0 7px rgba(110, 231, 183, 0.7)' }
  if (node.ramState === 'hibernated') return { background: 'transparent', border: '1px solid rgba(148, 163, 184, 0.55)' }
  return { background: 'rgba(52, 211, 153, 0.85)' }
}

/** Right-hand mono chip: `GHOST 92%` for echoes, `1·HOP` / `2·HOP` otherwise. */
function rowChip(entry: GlanceEntry): { label: string; className: string } {
  if (entry.isGhost) {
    return {
      label: `GHOST ${Math.round((entry.node.ghostMatch ?? 0) * 100)}%`,
      className: 'border-violet-400/30 bg-violet-400/10 text-violet-300',
    }
  }
  return entry.depth === 1
    ? { label: '1·HOP', className: 'border-white/10 bg-white/[0.04] text-white/50' }
    : { label: '2·HOP', className: 'border-white/[0.06] text-white/30' }
}

/* ------------------------------------------------------------------ */
/* Mini force graph (SVG + shared d3-force hook)                       */
/* ------------------------------------------------------------------ */

type GlanceForceGraphProps = {
  active: SpatialTabNodeRecord
  entries: GlanceEntry[]
  edges: GlanceEdge[]
  homes: Record<NodeUuid, LayoutPosition>
  /** §6 — the physics Freeze toggle stops the mini-graph too. */
  frozen: boolean
  hoveredUuid: NodeUuid | null
  onHover: (uuid: NodeUuid | null) => void
  onFocus: (uuid: NodeUuid) => void
  width: number
  height: number
}

function GlanceForceGraph({
  active,
  entries,
  edges,
  homes,
  frozen,
  hoveredUuid,
  onHover,
  onFocus,
  width,
  height,
}: GlanceForceGraphProps) {
  const nodeElsRef = useRef(new Map<NodeUuid, SVGGElement>())
  const edgeElsRef = useRef(new Map<string, SVGLineElement>())
  const edgeMetaRef = useRef(new Map<string, GlanceEdge>())

  /** Layout inputs: active pinned at centre (fx/fy), neighbours orbiting free. */
  const layoutNodes = useMemo<LayoutNodeInput[]>(() => {
    const activeHome = homes[active.uuid] ?? { x: width / 2, y: height / 2 }
    const list: LayoutNodeInput[] = [
      { uuid: active.uuid, x: activeHome.x, y: activeHome.y, fx: activeHome.x, fy: activeHome.y, isNew: false, radius: 12 },
    ]
    for (const entry of entries) {
      const home = homes[entry.node.uuid]
      if (!home) continue
      list.push({
        uuid: entry.node.uuid,
        x: home.x,
        y: home.y,
        fx: null,
        fy: null,
        isNew: false,
        radius: glanceNodeVisual(entry, false).radius + 4,
      })
    }
    return list
  }, [active, entries, homes, width, height])

  const layoutLinks = useMemo<LayoutLinkInput[]>(
    () => edges.map((edge) => ({ source: edge.source, target: edge.target, weight: Math.max(1, edge.weight) })),
    [edges],
  )

  /**
   * Positions arrive once per frame via the hook's onTick (mutating the same
   * record in place) — applied imperatively to the SVG, never via React
   * state, per the hook's performance contract.
   */
  const applyPositions = useCallback((positions: LayoutPositions) => {
    for (const [id, meta] of edgeMetaRef.current) {
      const el = edgeElsRef.current.get(id)
      if (!el) continue
      const from = positions[meta.source]
      const to = positions[meta.target]
      if (!from || !to) continue
      el.setAttribute('x1', from.x.toFixed(2))
      el.setAttribute('y1', from.y.toFixed(2))
      el.setAttribute('x2', to.x.toFixed(2))
      el.setAttribute('y2', to.y.toFixed(2))
    }
    for (const [uuid, el] of nodeElsRef.current) {
      const position = positions[uuid]
      if (!position) continue
      el.setAttribute('transform', `translate(${position.x.toFixed(2)} ${position.y.toFixed(2)})`)
    }
  }, [])

  const handleTick = useCallback(
    (positions: LayoutPositions) => {
      applyPositions(positions)
    },
    [applyPositions],
  )

  const { positionsRef, reheat } = useHybridForceLayout(layoutNodes, layoutLinks, { frozen, onTick: handleTick })

  useEffect(() => {
    edgeMetaRef.current = new Map<string, GlanceEdge>(edges.map((edge) => [edge.id, edge] as const))
    applyPositions(positionsRef.current)
  }, [edges, applyPositions, positionsRef])

  /**
   * "Small live force graph": re-energize on every composition/geometry
   * change so nodes visibly settle around their bearings. `onSettle` is
   * deliberately omitted — settling must never write positions back to the
   * store (§6 never auto-move).
   */
  useEffect(() => {
    reheat(0.4)
  }, [layoutNodes, reheat])

  useEffect(() => {
    const nodeEls = nodeElsRef.current
    const edgeEls = edgeElsRef.current
    return () => {
      nodeEls.clear()
      edgeEls.clear()
    }
  }, [])

  const registerNode = (uuid: NodeUuid) => (el: SVGGElement | null) => {
    if (el) nodeElsRef.current.set(uuid, el)
    else nodeElsRef.current.delete(uuid)
  }

  const registerEdge = (id: string) => (el: SVGLineElement | null) => {
    if (el) edgeElsRef.current.set(id, el)
    else edgeElsRef.current.delete(id)
  }

  const activeHome = homes[active.uuid] ?? { x: width / 2, y: height / 2 }

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="relative block" aria-hidden="true">
      <defs>
        <radialGradient id="glance-active-halo">
          <stop offset="0%" stopColor="rgba(110, 231, 183, 0.26)" />
          <stop offset="65%" stopColor="rgba(110, 231, 183, 0.06)" />
          <stop offset="100%" stopColor="rgba(110, 231, 183, 0)" />
        </radialGradient>
      </defs>

      {/* Edges — repositioned imperatively each frame. */}
      <g style={{ pointerEvents: 'none' }}>
        {edges.map((edge) => {
          const from = homes[edge.source]
          const to = homes[edge.target]
          if (!from || !to) return null
          const highlighted = hoveredUuid !== null && (edge.source === hoveredUuid || edge.target === hoveredUuid)
          const visual = glanceEdgeVisual(edge, highlighted)
          return (
            <line
              key={edge.id}
              ref={registerEdge(edge.id)}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={visual.stroke}
              strokeWidth={visual.width}
              strokeDasharray={visual.dasharray}
              strokeLinecap="round"
            />
          )
        })}
      </g>

      {/* Nodes — the active beacon pinned at centre, then BFS hops + ghosts. */}
      <g>
        <circle cx={activeHome.x} cy={activeHome.y} r={26} fill="url(#glance-active-halo)" style={{ pointerEvents: 'none' }} />
        <g
          ref={registerNode(active.uuid)}
          transform={`translate(${activeHome.x} ${activeHome.y})`}
          style={{ cursor: 'pointer' }}
          onClick={() => onFocus(active.uuid)}
          onMouseEnter={() => onHover(active.uuid)}
          onMouseLeave={() => onHover(null)}
        >
          <circle r={16} fill="none" stroke="rgba(110, 231, 183, 0.45)" strokeWidth={1.2} className="glance-pulse-ring" />
          <circle r={10} fill="#34D399" stroke="rgba(110, 231, 183, 0.9)" strokeWidth={1.5} />
          <title>{active.title}</title>
        </g>
        {entries.map((entry) => {
          const home = homes[entry.node.uuid]
          if (!home) return null
          const isHovered = hoveredUuid === entry.node.uuid
          const visual = glanceNodeVisual(entry, isHovered)
          return (
            <g
              key={entry.node.uuid}
              ref={registerNode(entry.node.uuid)}
              transform={`translate(${home.x} ${home.y})`}
              style={{ cursor: 'pointer' }}
              onClick={() => onFocus(entry.node.uuid)}
              onMouseEnter={() => onHover(entry.node.uuid)}
              onMouseLeave={() => onHover(null)}
            >
              {entry.isGhost ? (
                <circle r={11.5} fill="none" stroke="rgba(167, 139, 250, 0.35)" strokeWidth={1} strokeDasharray="2 3" />
              ) : null}
              <circle
                r={visual.radius}
                fill={visual.fill}
                stroke={visual.stroke}
                strokeWidth={visual.strokeWidth}
                strokeDasharray={visual.dashed ? '2.5 2.5' : undefined}
                className={entry.node.isLoading ? 'glance-loading-blink' : undefined}
              />
              {isHovered ? (
                <text
                  y={visual.radius + 12}
                  textAnchor="middle"
                  style={{
                    fontSize: 9,
                    fontFamily: 'var(--font-sans)',
                    letterSpacing: '-0.02em',
                    fill: 'rgba(241, 245, 249, 0.92)',
                    paintOrder: 'stroke',
                    stroke: 'rgba(9, 10, 12, 0.85)',
                    strokeWidth: 3,
                  }}
                >
                  {truncateLabel(entry.node.title, 26)}
                </text>
              ) : null}
              <title>{entry.node.title}</title>
            </g>
          )
        })}
      </g>
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/* NeighbourhoodGlance — the 300px glass panel (§3)                    */
/* ------------------------------------------------------------------ */

export function NeighbourhoodGlance({ className, width = 300 }: NeighbourhoodGlanceProps) {
  const glanceOpen = useGraphStore((s) => s.glanceOpen)
  const activeUuid = useGraphStore((s) => s.activeNodeUuid)
  const nodesMap = useGraphStore((s) => s.nodes)
  const edgesMap = useGraphStore((s) => s.edges)
  const physicsFrozen = useGraphStore((s) => s.physicsFrozen)
  const setGlanceOpen = useGraphStore((s) => s.setGlanceOpen)
  const focusNodeOnCanvas = useGraphStore((s) => s.focusNodeOnCanvas)

  const [hoveredUuid, setHoveredUuid] = useState<NodeUuid | null>(null)

  const active = activeUuid !== null ? (nodesMap[activeUuid] ?? null) : null

  /* §3 BFS neighbourhood (stable via useMemo over immutable store slices). */
  const neighbourhood = useMemo<NeighbourhoodResult>(() => {
    if (!active) return EMPTY_NEIGHBOURHOOD
    return selectNeighbourhood(useGraphStore.getState(), active.uuid, 2)
  }, [active, nodesMap, edgesMap])

  /* Ghost Echo suggestions materialized beside the active node (§4.3/§6). */
  const ghosts = useMemo<SpatialTabNodeRecord[]>(() => {
    if (!active) return []
    return selectGhostEchoNodes(useGraphStore.getState(), active.uuid)
  }, [active, nodesMap, edgesMap])

  const entries = useMemo<GlanceEntry[]>(() => {
    if (!active) return []
    const byUuid = new Map<NodeUuid, GlanceEntry>()
    for (const entry of neighbourhood.nodes) {
      byUuid.set(entry.node.uuid, {
        node: entry.node,
        depth: entry.depth,
        isGhost: entry.node.nodeType === 'ghost-echo',
      })
    }
    for (const ghost of ghosts) {
      if (!byUuid.has(ghost.uuid)) byUuid.set(ghost.uuid, { node: ghost, depth: 1, isGhost: true })
    }
    return [...byUuid.values()]
  }, [active, neighbourhood, ghosts])

  /* Edges among the visited set; synthesize a tether if a ghost lost its edge. */
  const graphEdges = useMemo<GlanceEdge[]>(() => {
    if (!active) return []
    const present = new Set<NodeUuid>(entries.map((entry) => entry.node.uuid))
    const seen = new Set<string>()
    const list: GlanceEdge[] = []
    for (const edgeRecord of neighbourhood.edges) {
      if (edgeRecord.source === edgeRecord.target) continue
      if (!present.has(edgeRecord.source) || !present.has(edgeRecord.target)) continue
      if (seen.has(edgeRecord.id)) continue
      seen.add(edgeRecord.id)
      list.push({
        id: edgeRecord.id,
        source: edgeRecord.source,
        target: edgeRecord.target,
        kind: edgeRecord.kind,
        weight: edgeRecord.weight,
      })
    }
    for (const entry of entries) {
      if (!entry.isGhost) continue
      const tetherId = `ghost-edge:${active.uuid}:${entry.node.uuid}`
      if (seen.has(tetherId)) continue
      seen.add(tetherId)
      list.push({ id: tetherId, source: active.uuid, target: entry.node.uuid, kind: 'ghost', weight: 0 })
    }
    return list
  }, [active, entries, neighbourhood])

  const graphWidth = Math.max(120, width - 32)
  const homes = useMemo<Record<NodeUuid, LayoutPosition>>(() => {
    if (!active) return {}
    return computeGlanceHomes(active, entries, graphWidth, GLANCE_GRAPH_HEIGHT)
  }, [active, entries, graphWidth])

  /** List order: strongest ghosts first, then 1-hop → 2-hop by recency. */
  const sortedEntries = useMemo<GlanceEntry[]>(() => {
    const ghostEntries = entries.filter((entry) => entry.isGhost)
    const tabEntries = entries.filter((entry) => !entry.isGhost)
    ghostEntries.sort((a, b) => (b.node.ghostMatch ?? 0) - (a.node.ghostMatch ?? 0))
    tabEntries.sort((a, b) => a.depth - b.depth || b.node.lastVisitedAt - a.node.lastVisitedAt)
    return [...ghostEntries, ...tabEntries]
  }, [entries])

  const hop1Count = entries.filter((entry) => !entry.isGhost && entry.depth === 1).length
  const hop2Count = entries.filter((entry) => !entry.isGhost && entry.depth === 2).length
  const ghostCount = entries.filter((entry) => entry.isGhost).length

  return (
    <AnimatePresence>
      {glanceOpen && active ? (
        <motion.aside
          key="neighbourhood-glance"
          aria-label="Neighbourhood glance"
          className={cn(
            'z-30 flex h-full flex-col overflow-hidden rounded-xl border border-hairline bg-surface-glass shadow-[0_18px_60px_rgba(0,0,0,0.5)] backdrop-blur-xl',
            className,
          )}
          style={{ width }}
          initial={{ x: 32, opacity: 0, scale: 0.985 }}
          animate={{ x: 0, opacity: 1, scale: 1 }}
          exit={{ x: 32, opacity: 0, scale: 0.985 }}
          transition={GLANCE_SPRING}
        >
          <style>{GLANCE_STYLES}</style>

          {/* Header — the active node the neighbourhood is built around. */}
          <header className="flex shrink-0 items-start gap-2 border-b border-hairline px-4 pb-3 pt-3.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <Radar size={11} className="shrink-0 text-accent" aria-hidden="true" />
                <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-white/40">
                  Neighbourhood Glance
                </span>
              </div>
              <p className="mt-1.5 truncate text-[13px] font-semibold leading-snug text-white/90" title={active.title}>
                {active.title}
              </p>
              <div className="mt-1 flex items-center gap-2">
                <span className="truncate font-mono text-[9.5px] text-white/40">{active.domain}</span>
                <span className="flex shrink-0 items-center gap-1 font-mono text-[9px] text-accent/90">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_6px_rgba(110,231,183,0.8)]" />
                  {formatRamMb(active.ramMb)}
                </span>
              </div>
            </div>
            <button
              type="button"
              aria-label="Close neighbourhood glance"
              onClick={() => setGlanceOpen(false)}
              className="rounded-md border border-transparent p-1 text-white/40 transition-colors hover:border-hairline hover:bg-white/[0.06] hover:text-white/80"
            >
              <X size={13} aria-hidden="true" />
            </button>
          </header>

          {/* Census strip — exactly what §3 allows into the panel. */}
          <div className="flex shrink-0 items-center gap-3 border-b border-hairline px-4 py-1.5 font-mono text-[8.5px] tracking-[0.14em] text-white/35">
            <span>{hop1Count} · 1-HOP</span>
            <span>{hop2Count} · 2-HOP</span>
            {ghostCount > 0 ? <span className="text-violet-300/80">{ghostCount} · GHOST</span> : null}
            <span className="ml-auto text-white/25">{entries.length} NODES</span>
          </div>

          {entries.length === 0 ? (
            <div className="flex min-h-0 flex-1 items-center justify-center border-b border-hairline px-6 text-center">
              <p className="text-[11px] leading-relaxed text-white/35">No connected neighbours within 2 hops.</p>
            </div>
          ) : (
            <>
              {/* Small live force graph on the void dot-matrix. */}
              <div className="relative shrink-0 border-b border-hairline" style={{ height: GLANCE_GRAPH_HEIGHT }}>
                <div
                  aria-hidden="true"
                  className="absolute inset-0"
                  style={{
                    backgroundImage: 'radial-gradient(rgba(255, 255, 255, 0.055) 1px, transparent 1px)',
                    backgroundSize: '13px 13px',
                    maskImage: 'radial-gradient(ellipse at center, black 55%, transparent 100%)',
                    WebkitMaskImage: 'radial-gradient(ellipse at center, black 55%, transparent 100%)',
                  }}
                />
                <GlanceForceGraph
                  active={active}
                  entries={entries}
                  edges={graphEdges}
                  homes={homes}
                  frozen={physicsFrozen}
                  hoveredUuid={hoveredUuid}
                  onHover={setHoveredUuid}
                  onFocus={focusNodeOnCanvas}
                  width={graphWidth}
                  height={GLANCE_GRAPH_HEIGHT}
                />
              </div>

              {/* Compact list of the same nodes (hover syncs with the graph). */}
              <div className="glance-scroll min-h-0 flex-1 overflow-y-auto px-2 py-2">
                {sortedEntries.map((entry) => {
                  const uuid = entry.node.uuid
                  const chip = rowChip(entry)
                  return (
                    <button
                      key={uuid}
                      type="button"
                      onClick={() => focusNodeOnCanvas(uuid)}
                      onMouseEnter={() => setHoveredUuid(uuid)}
                      onMouseLeave={() => setHoveredUuid(null)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50',
                        hoveredUuid === uuid ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]',
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn('h-2 w-2 shrink-0 rounded-full', entry.node.isLoading && 'glance-loading-blink')}
                        style={rowDotStyle(entry)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11.5px] leading-tight text-white/85">{entry.node.title}</span>
                        <span className="mt-0.5 flex items-center gap-1.5">
                          <span className="truncate font-mono text-[9px] text-white/35">{entry.node.domain}</span>
                          {entry.node.nodeType === 'hub' ? (
                            <span className="shrink-0 rounded bg-white/[0.06] px-1 font-mono text-[8px] text-white/40">HUB</span>
                          ) : null}
                        </span>
                      </span>
                      <span
                        className={cn(
                          'shrink-0 rounded border px-1.5 py-0.5 font-mono text-[8.5px] tracking-wide',
                          chip.className,
                        )}
                      >
                        {chip.label}
                      </span>
                    </button>
                  )
                })}
              </div>
            </>
          )}

          {/* Shortcut hint chip (§10 — nothing conflicts silently). */}
          <footer className="flex shrink-0 items-center gap-1.5 border-t border-hairline px-4 py-2">
            <MousePointerClick size={10} className="shrink-0 text-white/30" aria-hidden="true" />
            <span className="font-mono text-[8.5px] tracking-[0.14em] text-white/30">CLICK NODE → FOCUS CANVAS</span>
            <kbd className="ml-auto shrink-0 rounded border border-white/10 bg-white/[0.04] px-1 font-mono text-[8.5px] text-white/35">
              ⌘⇧G
            </kbd>
          </footer>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  )
}

export default NeighbourhoodGlance
