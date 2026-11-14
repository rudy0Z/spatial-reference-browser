/**
 * app/src/components/canvas/SpatialCanvas.tsx — Mode B: the infinite spatial
 * graph canvas (SPEC §3 Mode B, §4 semantic-zoom LOD, §6 founder addenda).
 *
 * Architecture:
 *  - `@xyflow/react` v12 renders the scene graph; data flows store → canvas
 *    through the pure selectors (`selectCanvasNodes`, `selectCanvasEdges`,
 *    `selectWorkbenchNodes`, `selectRegionList`).
 *  - `useHybridForceLayout` solves pinned anchors (fx/fy) + gently orbiting
 *    satellites. Its per-frame `onTick` positions are applied IMPERATIVELY to
 *    React Flow's internal store — coalesced (single `setNodes` per frame,
 *    ≤ MAX_POSITION_UPDATES_PER_TICK nodes, sub-epsilon motion skipped) and
 *    never copied into React state per tick, so panning 600 nodes stays smooth.
 *  - Semantic-zoom watcher: `onMove` mirrors the viewport zoom into the store
 *    (`setZoom`, clamped 0.15..2); `lodForZoom` derives the 3 LOD tiers
 *    (macro < 0.35 / compact < 0.65 / rich ≥ 0.65). The tier flows into every
 *    node's data (so SpatialTabNode genuinely unmounts heavy DOM at macro),
 *    toggles the macro region-title layer, and switches the edge flow
 *    animation off at macro via a `[data-lod]` CSS hook.
 *  - Interactions: click → `activateNode` (ghosts delegate to wake), dblclick
 *    → `toggleStack` (§4.5 deck), drag-end → `moveNode({pin:true})`
 *    (drag-to-anchor §6), HUD toggles for semantic-zoom override + physics
 *    Freeze/Relax, quick sticky/region creators, and the Active Workbench
 *    Tray with faint tether lines back to home regions (§6 gravity well).
 *
 * Design language: SPEC §2 dark tactical glass, framer-motion springs
 * (stiffness 380 / damping 30), lucide-react icons, clsx + tailwind-merge.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode, RefObject } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { Transition } from 'framer-motion'
import { Map as MapIcon, Plus, ScanEye, Snowflake, StickyNote, Volume2, Waves, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  getSmoothStepPath,
  useReactFlow,
  useViewport,
} from '@xyflow/react'
import type { EdgeProps, EdgeTypes, NodeTypes, OnMove, Viewport } from '@xyflow/react'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { useGraphStore } from '../../store/useGraphStore'
import { selectCanvasEdges, selectCanvasNodes, selectRegionList, selectWorkbenchNodes } from '../../store/useGraphStore'
import { useHybridForceLayout } from '../../hooks/useHybridForceLayout'
import type { LayoutLinkInput, LayoutNodeInput, LayoutPositions } from '../../hooks/useHybridForceLayout'
import { lodForZoom } from '../../lib/types'
import type {
  GraphEdgeKind,
  NodeUuid,
  Region,
  SemanticZoomLevel,
  SpatialCanvasProps,
  SpatialFlowEdge,
  SpatialTabFlowNode,
  SpatialTabNodeRecord,
  ViewMode,
} from '../../lib/types'
import SpatialTabNode from './nodes/SpatialTabNode'

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** §4 collision radius handed to the hybrid layout, per semantic-zoom tier. */
const LOD_RADIUS: Record<SemanticZoomLevel, number> = {
  macro: 14,
  compact: 24,
  rich: 40,
}

/** Edge accents per §2 (spawn = pine signal, visit = neutral, ghost = spectral). */
const EDGE_COLORS: Record<GraphEdgeKind, string> = {
  spawn: '#34D399',
  visit: 'rgba(226, 232, 240, 0.55)',
  ghost: '#A78BFA',
}

/** Sub-epsilon motion is considered static — keeps slow orbit wobble cheap. */
const POSITION_EPSILON_PX = 0.4

/** Max nodes whose position is pushed into React Flow per animation frame. */
const MAX_POSITION_UPDATES_PER_TICK = 40

/** SPEC §2 motion language — snappy springs, never linear. */
const SPRING_TRANSITION: Transition = { type: 'spring', stiffness: 380, damping: 30 }

const NODE_TYPES: NodeTypes = { spatialTab: SpatialTabNode }
const EDGE_TYPES: EdgeTypes = { spatialFlow: SpatialFlowEdgeView }

const CANVAS_STYLES = `
  @keyframes sp-edge-flow {
    to { stroke-dashoffset: -13; }
  }
  @keyframes sp-ghost-pulse {
    0%, 100% { opacity: 0.35; }
    50% { opacity: 0.85; }
  }
  .sp-edge-flow {
    animation: sp-edge-flow 1.6s linear infinite;
  }
  .sp-ghost-edge {
    animation: sp-ghost-pulse 3.4s ease-in-out infinite;
  }
  [data-lod='macro'] .sp-edge-flow {
    display: none;
  }
  .react-flow__attribution {
    background: transparent;
  }
  .react-flow__attribution a {
    color: rgba(255, 255, 255, 0.22);
  }
`

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function cn(...inputs: Array<string | false | null | undefined>): string {
  return twMerge(clsx(inputs))
}

/** Hex → rgba() with alpha, for region halos/glows derived from REGION_COLORS. */
function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace('#', '')
  const full = clean.length === 3 ? clean.split('').map((ch) => ch + ch).join('') : clean
  const num = Number.parseInt(full, 16)
  if (Number.isNaN(num)) return hex
  const r = (num >> 16) & 255
  const g = (num >> 8) & 255
  const b = num & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/* ------------------------------------------------------------------ */
/* Custom edge — directional smoothstep with traversal-flow animation  */
/* ------------------------------------------------------------------ */

function SpatialFlowEdgeView({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  data,
  markerEnd,
}: EdgeProps<SpatialFlowEdge>) {
  const kind: GraphEdgeKind = data?.kind ?? 'visit'
  const weight = data?.weight ?? 1
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 18,
    offset: 26,
  })

  if (kind === 'ghost') {
    return (
      <BaseEdge
        id={id}
        path={path}
        className="sp-ghost-edge"
        interactionWidth={10}
        style={{ stroke: EDGE_COLORS.ghost, strokeWidth: 1.2, strokeDasharray: '6 7' }}
      />
    )
  }

  const color = EDGE_COLORS[kind]
  const strokeWidth = 1 + Math.min(2.6, weight * 0.35)
  // Heavier co-visitation → faster traversal pulses.
  const flowDuration = `${Math.max(0.8, 2.2 - Math.min(1.4, weight * 0.16)).toFixed(2)}s`

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={14}
        style={{ stroke: color, strokeWidth, opacity: kind === 'spawn' ? 0.55 : 0.4 }}
      />
      <path
        d={path}
        fill="none"
        className="sp-edge-flow"
        stroke={color}
        strokeWidth={strokeWidth + 0.5}
        strokeLinecap="round"
        strokeDasharray="2 11"
        style={{ animationDuration: flowDuration, pointerEvents: 'none' }}
      />
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Region halos + macro titles (§4.1, §6 — regions replace workspaces) */
/* ------------------------------------------------------------------ */

function RegionTitlesLayer({ regions, showTitles }: { regions: Region[]; showTitles: boolean }) {
  const { zoom } = useViewport()
  if (regions.length === 0) return null
  const titleFontSize = 40 / Math.max(0.15, zoom)
  return (
    <ViewportPortal>
      {regions.map((region) => (
        <div
          key={region.id}
          style={{
            position: 'absolute',
            left: region.center.x,
            top: region.center.y,
            zIndex: -1,
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: -region.radius,
              top: -region.radius,
              width: region.radius * 2,
              height: region.radius * 2,
              borderRadius: '50%',
              border: `1px solid ${withAlpha(region.color, 0.16)}`,
              background: `radial-gradient(circle, ${withAlpha(region.color, 0.06)} 0%, rgba(9, 10, 12, 0) 70%)`,
              opacity: showTitles ? 1 : 0.5,
              transition: 'opacity 240ms ease',
            }}
          />
          {showTitles ? (
            <div
              className="font-sans font-semibold uppercase"
              style={{
                position: 'absolute',
                left: 0,
                top: -(region.radius + 14),
                transform: 'translate(-50%, -100%)',
                fontSize: titleFontSize,
                letterSpacing: '0.16em',
                whiteSpace: 'nowrap',
                color: withAlpha(region.color, 0.85),
                textShadow: `0 0 26px ${withAlpha(region.color, 0.45)}`,
              }}
            >
              {region.name}
            </div>
          ) : null}
        </div>
      ))}
    </ViewportPortal>
  )
}

/* ------------------------------------------------------------------ */
/* Workbench tether layer — faint lines from tray chips to home regions */
/* ------------------------------------------------------------------ */

type WorkbenchTetherLayerProps = {
  containerRef: RefObject<HTMLDivElement | null>
  chipElsRef: RefObject<Map<NodeUuid, HTMLElement>>
  workbench: SpatialTabNodeRecord[]
  regions: Region[]
}

function WorkbenchTetherLayer({ containerRef, chipElsRef, workbench, regions }: WorkbenchTetherLayerProps) {
  const viewport = useViewport()
  const { flowToScreenPosition } = useReactFlow<SpatialTabFlowNode, SpatialFlowEdge>()
  const [, setRenderTick] = useState(0)
  const bump = useCallback(() => setRenderTick((tick) => tick + 1), [])

  useEffect(() => {
    // First paint catch-up (chip rects exist only after the dock mounts) —
    // deferred to rAF so it isn't a synchronous cascading setState.
    const frame = requestAnimationFrame(bump)
    window.addEventListener('resize', bump)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', bump)
    }
  }, [bump])

  const container = containerRef.current
  if (!container) return null
  const containerRect = container.getBoundingClientRect()
  // Tethers matter most far out; they fade as you zoom in.
  const tetherOpacity = Math.max(0.07, Math.min(0.22, 0.1 * viewport.zoom + 0.09))

  const segments: ReactNode[] = []
  for (const node of workbench) {
    const region = node.regionId ? regions.find((candidate) => candidate.id === node.regionId) : undefined
    if (!region) continue
    const chip = chipElsRef.current.get(node.uuid)
    const chipRect = chip?.getBoundingClientRect()
    if (!chipRect || chipRect.width === 0) continue
    const regionScreen = flowToScreenPosition(region.center)
    const x1 = chipRect.left + chipRect.width / 2 - containerRect.left
    const y1 = chipRect.top - containerRect.top + 1
    const x2 = regionScreen.x - containerRect.left
    const y2 = regionScreen.y - containerRect.top
    const midX = (x1 + x2) / 2
    const midY = (y1 + y2) / 2 - Math.min(130, Math.abs(x2 - x1) * 0.28)
    segments.push(
      <g key={node.uuid}>
        <path
          d={`M ${x1.toFixed(1)} ${y1.toFixed(1)} Q ${midX.toFixed(1)} ${midY.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`}
          fill="none"
          stroke={region.color}
          strokeWidth={1}
          strokeOpacity={tetherOpacity}
          strokeDasharray="2 7"
          strokeLinecap="round"
        />
        <circle cx={x2} cy={y2} r={2.5} fill={region.color} fillOpacity={tetherOpacity + 0.25} />
      </g>,
    )
  }
  return <svg className="pointer-events-none absolute inset-0 z-20 h-full w-full overflow-visible">{segments}</svg>
}

/* ------------------------------------------------------------------ */
/* Bottom HUD dock (§3 Mode B)                                         */
/* ------------------------------------------------------------------ */

type HudToggleProps = {
  icon: LucideIcon
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
}

function HudToggle({ icon: Icon, label, active = false, disabled = false, onClick }: HudToggleProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={cn(
        'flex items-center gap-1.5 rounded-lg px-2 py-1.5 transition-colors duration-150',
        active ? 'bg-accent/15 text-accent' : 'text-white/55 hover:bg-white/[0.06] hover:text-white/90',
        disabled && 'pointer-events-none opacity-35',
      )}
    >
      <Icon size={13} strokeWidth={2} aria-hidden />
      <span className="font-mono text-[9.5px] uppercase tracking-ui">{label}</span>
      {active ? <span className="h-1 w-1 rounded-full bg-accent shadow-[0_0_6px_rgba(52,211,153,0.9)]" /> : null}
    </button>
  )
}

function DockDivider() {
  return <div className="mx-1 h-5 w-px shrink-0 bg-hairline" />
}

function RegionCreator({ onCreate }: { onCreate: (name: string) => void }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const submit = () => {
    onCreate(value.trim() || 'New Region')
    setValue('')
    setOpen(false)
  }

  return (
    <div className="relative">
      <HudToggle icon={MapIcon} label="Region" active={open} onClick={() => setOpen((previous) => !previous)} />
      <AnimatePresence>
        {open ? (
          <motion.div
            key="region-creator"
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={SPRING_TRANSITION}
            className="absolute bottom-full left-1/2 z-40 mb-2 -translate-x-1/2"
          >
            <div className="flex items-center gap-1.5 rounded-xl border border-hairline bg-surface-glass px-2 py-1.5 shadow-[0_18px_50px_rgba(0,0,0,0.55)] backdrop-blur-xl">
              <input
                ref={inputRef}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') submit()
                  else if (event.key === 'Escape') setOpen(false)
                }}
                placeholder="Region name…"
                className="w-44 bg-transparent font-sans text-[12px] text-white/90 outline-none placeholder:text-white/30"
              />
              <button
                type="button"
                onClick={submit}
                title="Create region"
                className="rounded-md bg-accent/15 p-1 text-accent transition-colors hover:bg-accent/25"
              >
                <Plus size={12} aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                title="Cancel"
                className="rounded-md p-1 text-white/50 transition-colors hover:bg-white/[0.08] hover:text-white/85"
              >
                <X size={12} aria-hidden />
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

type HudDockProps = {
  regions: Region[]
  workbench: SpatialTabNodeRecord[]
  chipElsRef: RefObject<Map<NodeUuid, HTMLElement>>
  onFocusNode: (uuid: NodeUuid) => void
  onQuickNote: () => boolean
  onCreateRegion: (name: string) => void
}

function HudDock({ regions, workbench, chipElsRef, onFocusNode, onQuickNote, onCreateRegion }: HudDockProps) {
  const zoom = useGraphStore((state) => state.zoom)
  const frozen = useGraphStore((state) => state.physicsFrozen)
  const override = useGraphStore((state) => state.semanticZoomOverride)
  const activeUuid = useGraphStore((state) => state.activeNodeUuid)
  const lod = lodForZoom(zoom, override)

  const [noteFlash, setNoteFlash] = useState(false)
  const flashTimerRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current)
    },
    [],
  )

  const handleQuickNoteClick = () => {
    if (!onQuickNote()) return
    setNoteFlash(true)
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current)
    flashTimerRef.current = window.setTimeout(() => setNoteFlash(false), 700)
  }

  return (
    <div className="absolute bottom-4 left-1/2 z-30 w-max max-w-[94vw] -translate-x-1/2">
      <motion.div
        initial={{ y: 26, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={SPRING_TRANSITION}
        className="flex flex-wrap items-center justify-center gap-1 rounded-2xl border border-hairline bg-surface-glass px-2.5 py-2 shadow-[0_18px_50px_rgba(0,0,0,0.55)] backdrop-blur-xl"
      >
        {/* zoom percentage + current semantic-zoom tier */}
        <div className="flex items-center gap-2 py-0.5 pl-1 pr-1.5">
          <span className="font-mono text-[11px] tabular-nums text-white/80">{Math.round(zoom * 100)}%</span>
          <span className="rounded-md border border-hairline bg-white/[0.04] px-1.5 py-0.5 font-mono text-[9px] uppercase text-white/45">
            {lod}
          </span>
        </div>

        <DockDivider />

        <HudToggle
          icon={ScanEye}
          label="LOD lock"
          active={override}
          onClick={() => useGraphStore.getState().toggleSemanticZoomOverride()}
        />
        <HudToggle
          icon={frozen ? Waves : Snowflake}
          label={frozen ? 'Relax' : 'Freeze'}
          active={frozen}
          onClick={() => useGraphStore.getState().togglePhysicsFrozen()}
        />

        <DockDivider />

        <HudToggle
          icon={StickyNote}
          label="Note"
          active={noteFlash}
          disabled={activeUuid === null}
          onClick={handleQuickNoteClick}
        />
        <RegionCreator onCreate={onCreateRegion} />

        <DockDivider />

        {/* Active Workbench Tray — magnetic dock of the 3–5 live tabs (§3, §6) */}
        <div className="flex items-center gap-1.5 pl-1">
          <span className="hidden font-mono text-[9px] uppercase tracking-ui text-white/30 lg:inline">Workbench</span>
          {workbench.length === 0 ? (
            <span className="px-1.5 text-[10px] text-white/30">No live tabs</span>
          ) : (
            workbench.map((node) => {
              const color = regions.find((region) => region.id === node.regionId)?.color ?? null
              const isActive = node.uuid === activeUuid
              return (
                <motion.button
                  key={node.uuid}
                  type="button"
                  ref={(el) => {
                    if (el) chipElsRef.current.set(node.uuid, el)
                    else chipElsRef.current.delete(node.uuid)
                  }}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.94 }}
                  transition={SPRING_TRANSITION}
                  onClick={() => onFocusNode(node.uuid)}
                  title={`${node.title} · ${node.domain}`}
                  className={cn(
                    'flex max-w-[168px] items-center gap-1.5 rounded-xl border px-2 py-1.5 text-left transition-colors',
                    isActive ? 'border-accent/55 bg-accent/10' : 'border-hairline bg-white/[0.04] hover:bg-white/[0.09]',
                  )}
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      backgroundColor: color ?? 'rgba(255,255,255,0.3)',
                      boxShadow: color ? `0 0 8px ${withAlpha(color, 0.55)}` : undefined,
                    }}
                  />
                  <span className="truncate text-[10.5px] font-medium leading-none text-white/85">{node.title}</span>
                  {node.isAudible ? <Volume2 size={11} className="shrink-0 text-accent" aria-hidden /> : null}
                </motion.button>
              )
            })
          )}
        </div>
      </motion.div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* SpatialCanvas                                                       */
/* ------------------------------------------------------------------ */

function SpatialCanvasInner({ className }: SpatialCanvasProps) {
  /* Store slices (primitive or stable-record — safe for zustand v5 selectors). */
  const nodesRecord = useGraphStore((state) => state.nodes)
  const edgesRecord = useGraphStore((state) => state.edges)
  const regionsRecord = useGraphStore((state) => state.regions)
  const notesRecord = useGraphStore((state) => state.notes)
  const memosRecord = useGraphStore((state) => state.voiceMemos)
  const collapsedStacks = useGraphStore((state) => state.collapsedStacks)
  const activeNodeUuid = useGraphStore((state) => state.activeNodeUuid)
  const workbenchUuids = useGraphStore((state) => state.workbenchUuids)
  const viewMode = useGraphStore((state) => state.viewMode)
  const semanticZoomOverride = useGraphStore((state) => state.semanticZoomOverride)
  const physicsFrozen = useGraphStore((state) => state.physicsFrozen)
  const zoom = useGraphStore((state) => state.zoom)

  const { setNodes, setCenter, screenToFlowPosition, getNodes } = useReactFlow<SpatialTabFlowNode, SpatialFlowEdge>()

  /* Imperative frame buffers — mutated in place, never React state. */
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chipElsRef = useRef<Map<NodeUuid, HTMLElement>>(new Map())
  const draggingUuidsRef = useRef<Set<NodeUuid>>(new Set())
  /** Last position actually applied to React Flow (epsilon/coalescing bookkeeping). */
  const lastAppliedRef = useRef<LayoutPositions>({})
  const prevViewModeRef = useRef<ViewMode | null>(null)

  const lod = lodForZoom(zoom, semanticZoomOverride)

  /* Store → view-model (contract selectors; getState() is render-time consistent
     because the subscribed slices are the exact inputs these selectors read). */
  const canvasNodes = useMemo(
    () => selectCanvasNodes(useGraphStore.getState()),
    [nodesRecord, collapsedStacks],
  )
  const canvasEdges = useMemo(
    () => selectCanvasEdges(useGraphStore.getState()),
    [edgesRecord, nodesRecord, collapsedStacks],
  )
  const regionsList = useMemo(() => selectRegionList(useGraphStore.getState()), [regionsRecord])
  const workbenchNodes = useMemo(
    () => selectWorkbenchNodes(useGraphStore.getState()),
    [workbenchUuids, nodesRecord],
  )

  const workbenchSet = useMemo(() => new Set(workbenchUuids), [workbenchUuids])
  const collapsedSet = useMemo(() => new Set(collapsedStacks), [collapsedStacks])

  /** Per-render derived counts for SpatialTabNodeData (single O(n) pass each). */
  const derivedCounts = useMemo(() => {
    const noteCountByUrlHash = new Map<string, number>()
    for (const note of Object.values(notesRecord)) {
      noteCountByUrlHash.set(note.urlHash, (noteCountByUrlHash.get(note.urlHash) ?? 0) + 1)
    }
    const memoNodeIds = new Set<NodeUuid>()
    for (const memo of Object.values(memosRecord)) memoNodeIds.add(memo.nodeId)
    const childCountByParent = new Map<NodeUuid, number>()
    for (const node of Object.values(nodesRecord)) {
      if (node.parentUuid) childCountByParent.set(node.parentUuid, (childCountByParent.get(node.parentUuid) ?? 0) + 1)
    }
    return { noteCountByUrlHash, memoNodeIds, childCountByParent }
  }, [notesRecord, memosRecord, nodesRecord])

  /* Hybrid physics inputs — persisted home coordinates (never the orbit-wobbled
     render positions, so §6 "never auto-move existing nodes" holds). */
  const layoutNodes = useMemo<LayoutNodeInput[]>(
    () =>
      canvasNodes.map((node) => ({
        uuid: node.uuid,
        x: node.x,
        y: node.y,
        fx: node.fx,
        fy: node.fy,
        isNew: !node.settled,
        radius: LOD_RADIUS[lod],
      })),
    [canvasNodes, lod],
  )
  const layoutLinks = useMemo<LayoutLinkInput[]>(
    () => canvasEdges.map((edge) => ({ source: edge.source, target: edge.target, weight: edge.weight })),
    [canvasEdges],
  )

  /* ---- per-frame imperative position application (coalesced) ---- */
  const handleTick = useCallback(
    (positions: LayoutPositions) => {
      const byId = new Map<NodeUuid, { x: number; y: number }>()
      let budget = MAX_POSITION_UPDATES_PER_TICK
      for (const [uuid, position] of Object.entries(positions)) {
        if (draggingUuidsRef.current.has(uuid)) continue
        const previous = lastAppliedRef.current[uuid]
        if (
          previous &&
          Math.abs(previous.x - position.x) <= POSITION_EPSILON_PX &&
          Math.abs(previous.y - position.y) <= POSITION_EPSILON_PX
        ) {
          continue
        }
        if (budget <= 0) continue
        const entry = { x: position.x, y: position.y }
        lastAppliedRef.current[uuid] = entry
        byId.set(uuid, entry)
        budget -= 1
      }
      if (byId.size === 0) return
      // Single setNodes per frame; untouched nodes keep object identity so RF
      // memoization skips their re-render.
      setNodes((current) =>
        current.map((node) => {
          const next = byId.get(node.id)
          if (!next) return node
          return { ...node, position: { x: next.x, y: next.y } }
        }),
      )
    },
    [setNodes],
  )

  const handleSettle = useCallback((uuid: NodeUuid, x: number, y: number) => {
    useGraphStore.getState().commitSatellitePosition(uuid, x, y)
  }, [])

  useHybridForceLayout(layoutNodes, layoutLinks, {
    frozen: physicsFrozen,
    orbit: true,
    onTick: handleTick,
    onSettle: handleSettle,
  })

  /* ---- store → React Flow elements ---- */
  const flowNodes = useMemo<SpatialTabFlowNode[]>(() => {
    return canvasNodes.map((node) => {
      const region = node.regionId ? regionsRecord[node.regionId] : undefined
      // Bake the last position actually applied to React Flow (read-only
      // render-side access to the imperative frame buffer — the write side is
      // handleTick/handleNodeDrag, so what is baked always matches what RF
      // shows and rebuilds never snap the map).
      const rendered = lastAppliedRef.current[node.uuid] ?? { x: node.x, y: node.y }
      return {
        id: node.uuid,
        type: 'spatialTab',
        position: rendered,
        data: {
          node,
          lod,
          semanticZoomOverride,
          regionName: region?.name ?? null,
          regionColor: region?.color ?? null,
          isActive: node.uuid === activeNodeUuid,
          isWorkbench: workbenchSet.has(node.uuid),
          noteCount: derivedCounts.noteCountByUrlHash.get(node.urlHash) ?? 0,
          hasVoiceMemo: derivedCounts.memoNodeIds.has(node.uuid),
          childCount: derivedCounts.childCountByParent.get(node.uuid) ?? 0,
          isStackCollapsed: collapsedSet.has(node.uuid),
        },
        zIndex: node.nodeType === 'ghost-echo' ? 40 : node.uuid === activeNodeUuid ? 30 : 10,
        selectable: false,
      }
    })
  }, [canvasNodes, lod, semanticZoomOverride, regionsRecord, activeNodeUuid, workbenchSet, derivedCounts, collapsedSet])

  const flowEdges = useMemo<SpatialFlowEdge[]>(
    () =>
      canvasEdges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'spatialFlow',
        data: { kind: edge.kind, weight: edge.weight },
        markerEnd:
          edge.kind === 'ghost'
            ? undefined
            : { type: MarkerType.ArrowClosed, color: EDGE_COLORS[edge.kind], width: 14, height: 14 },
        zIndex: edge.kind === 'ghost' ? 6 : 2,
      })),
    [canvasEdges],
  )

  /* ---- viewport / interaction wiring ---- */
  const handleMove = useCallback<OnMove>(
    (_event, viewport: Viewport) => {
      const current = useGraphStore.getState().zoom
      // Panning doesn't change zoom — skip the store write entirely.
      if (Math.abs(current - viewport.zoom) > 0.001) useGraphStore.getState().setZoom(viewport.zoom)
    },
    [],
  )

  const handleNodeClick = useCallback((_event: ReactMouseEvent, node: SpatialTabFlowNode) => {
    useGraphStore.getState().activateNode(node.id)
  }, [])

  const handleNodeDoubleClick = useCallback((_event: ReactMouseEvent, node: SpatialTabFlowNode) => {
    useGraphStore.getState().toggleStack(node.id)
  }, [])

  const handleNodeDragStart = useCallback((_event: MouseEvent | TouchEvent, node: SpatialTabFlowNode) => {
    draggingUuidsRef.current.add(node.id)
  }, [])

  const handleNodeDrag = useCallback((_event: MouseEvent | TouchEvent, node: SpatialTabFlowNode) => {
    // Keep the render buffer in sync so a concurrent store rebuild never snaps
    // the dragged node back to its pre-drag position.
    lastAppliedRef.current[node.id] = { x: node.position.x, y: node.position.y }
  }, [])

  const handleNodeDragStop = useCallback((_event: MouseEvent | TouchEvent, node: SpatialTabFlowNode) => {
    draggingUuidsRef.current.delete(node.id)
    lastAppliedRef.current[node.id] = { x: node.position.x, y: node.position.y }
    // §6 drag-to-anchor — dropping a node anchors it: physics never drifts it again.
    useGraphStore.getState().moveNode(node.id, node.position.x, node.position.y, { pin: true })
  }, [])

  /* ---- HUD callbacks ---- */
  const handleFocusNode = useCallback(
    (uuid: NodeUuid) => {
      useGraphStore.getState().activateNode(uuid)
      const rec = useGraphStore.getState().nodes[uuid]
      if (!rec) return
      // The d3-force layout owns the live position once physics has run — the
      // store's (x, y) is only the seed/spawn record and can be far away.
      const flowNode = getNodes().find((n) => n.id === uuid)
      const x = flowNode?.position.x ?? rec.x
      const y = flowNode?.position.y ?? rec.y
      // Center the card's body, not its top-left origin.
      const w = flowNode?.measured?.width ?? 0
      const h = flowNode?.measured?.height ?? 0
      setCenter(x + w / 2, y + h / 2, { zoom: Math.max(0.6, useGraphStore.getState().zoom), duration: 450 })
    },
    [setCenter, getNodes],
  )

  const handleQuickNote = useCallback((): boolean => useGraphStore.getState().quickNoteOnActive() !== null, [])

  const handleCreateRegion = useCallback(
    (name: string) => {
      const center = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
      useGraphStore.getState().createRegion(name, center)
    },
    [screenToFlowPosition],
  )

  /* Entering canvas mode: glide to the active node (keep the store zoom —
     /seed-600 intentionally lands at 0.3 to demo the macro tier). The d3-force
     layout is still converging right after mount, so chase the live flow
     position until it stabilizes (or 4s elapses), then lock the camera. */
  useEffect(() => {
    const enteredCanvas = prevViewModeRef.current !== viewMode && viewMode === 'canvas'
    prevViewModeRef.current = viewMode
    if (!enteredCanvas) return
    const state = useGraphStore.getState()
    const node = state.activeNodeUuid ? state.nodes[state.activeNodeUuid] : undefined
    if (!node) return
    let last: { x: number; y: number } | null = null
    let stableTicks = 0
    const startedAt = performance.now()
    const timer = window.setInterval(() => {
      const flowNode = getNodes().find((n) => n.id === node.uuid)
      const x = flowNode?.position.x ?? node.x
      const y = flowNode?.position.y ?? node.y
      // Center the card's body, not its top-left origin.
      const w = flowNode?.measured?.width ?? 0
      const h = flowNode?.measured?.height ?? 0
      setCenter(x + w / 2, y + h / 2, { zoom: useGraphStore.getState().zoom, duration: 260 })
      if (last && Math.abs(last.x - x) < 0.5 && Math.abs(last.y - y) < 0.5) stableTicks += 1
      else stableTicks = 0
      last = { x, y }
      if (stableTicks >= 2 || performance.now() - startedAt > 4000) {
        window.clearInterval(timer)
        setCenter(x + w / 2, y + h / 2, { zoom: useGraphStore.getState().zoom, duration: 450 })
      }
    }, 200)
    return () => window.clearInterval(timer)
  }, [viewMode, setCenter, getNodes])

  const [defaultViewport] = useState<Viewport>(() => ({ x: 0, y: 0, zoom: useGraphStore.getState().zoom }))

  return (
    <AnimatePresence>
      {viewMode === 'canvas' ? (
        <motion.div
          key="spatial-canvas-root"
          initial={{ opacity: 0, scale: 0.985 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.99 }}
          transition={SPRING_TRANSITION}
          className={cn('fixed inset-0 z-10 overflow-hidden bg-void', className)}
          data-lod={lod}
        >
          <style>{CANVAS_STYLES}</style>
          <div ref={containerRef} className="relative h-full w-full">
            <ReactFlow<SpatialTabFlowNode, SpatialFlowEdge>
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              onlyRenderVisibleElements
              minZoom={0.15}
              maxZoom={2}
              defaultViewport={defaultViewport}
              onMove={handleMove}
              onNodeClick={handleNodeClick}
              onNodeDoubleClick={handleNodeDoubleClick}
              onNodeDragStart={handleNodeDragStart}
              onNodeDrag={handleNodeDrag}
              onNodeDragStop={handleNodeDragStop}
              elementsSelectable={false}
              nodesConnectable={false}
              zoomOnDoubleClick={false}
              deleteKeyCode={null}
            >
              <Background
                variant={BackgroundVariant.Dots}
                bgColor="#090A0C"
                color="#1C1F26"
                gap={26}
                size={1.4}
              />
              <RegionTitlesLayer regions={regionsList} showTitles={lod === 'macro'} />
            </ReactFlow>

            {/* Radial vignette — the dot-matrix grid fades into the void (§2) */}
            <div
              className="pointer-events-none absolute inset-0 z-[5]"
              style={{
                background:
                  'radial-gradient(ellipse 90% 80% at 50% 45%, rgba(9, 10, 12, 0) 55%, rgba(9, 10, 12, 0.6) 100%)',
              }}
            />

            <WorkbenchTetherLayer
              containerRef={containerRef}
              chipElsRef={chipElsRef}
              workbench={workbenchNodes}
              regions={regionsList}
            />

            <HudDock
              regions={regionsList}
              workbench={workbenchNodes}
              chipElsRef={chipElsRef}
              onFocusNode={handleFocusNode}
              onQuickNote={handleQuickNote}
              onCreateRegion={handleCreateRegion}
            />
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

/**
 * Mode B — the infinite spatial graph canvas. Fully store-driven:
 * zoom/LOD, physics freeze, override toggle, workbench tray, collapse stacks
 * and node positions all flow through `useGraphStore` + `useHybridForceLayout`.
 */
export function SpatialCanvas({ className }: SpatialCanvasProps) {
  return (
    <ReactFlowProvider>
      <SpatialCanvasInner className={className} />
    </ReactFlowProvider>
  )
}

export default SpatialCanvas
