/**
 * app/src/components/canvas/SpatialCanvas.tsx — Mode B: the infinite spatial
 * graph canvas (SPEC §3 Mode B, §4 semantic-zoom LOD, §6 founder addenda),
 * redesigned to the Phase 1.5 calm-graph grammar ("Zen × Blanc × Obsidian
 * Minimal", ZCODE_MASTER_PROMPT.md §Phase 1.5).
 *
 * Architecture:
 *  - `@xyflow/react` v12 renders the scene graph; data flows store → canvas
 *    through the pure selectors (`selectCanvasNodes`, `selectCanvasEdges`,
 *    `selectWorkbenchNodes`, `selectRegionList`).
 *  - `useHybridForceLayout` solves pinned anchors (fx/fy) + gently orbiting
 *    satellites. Its per-frame `onTick` positions are applied IMPERATIVELY to
 *    React Flow's internal store — coalesced (single `setNodes` per frame,
 *    ≤ MAX_POSITION_UPDATES_PER_TICK nodes, sub-epsilon motion skipped) and
 *    never copied into React state per tick, so panning 600+ nodes stays smooth.
 *  - Semantic-zoom watcher: `onMove` mirrors the viewport zoom into the store
 *    (`setZoom`, clamped 0.15..2); `lodForZoom` derives the 3 LOD tiers
 *    (macro < 0.35 / compact < 0.65 / rich ≥ 0.65). The tier flows into every
 *    node's data (so SpatialTabNode genuinely unmounts heavy DOM at macro)
 *    and scales the region label layer to constant screen size.
 *  - Calm edges: every edge is a STATIC 1px smooth bezier. Rest stroke =
 *    var(--border-subtle); hovering a node illuminates its 1-hop lineage to
 *    var(--ink-primary) @ 45% (≈ rgba(255,255,255,0.45) in dark, dark ink in
 *    Warm Paper) and dims unrelated nodes/edges/zones to opacity 0.25 via one
 *    CSS rule + smooth opacity transitions. Zero dash arrays, zero keyframes,
 *    zero edge glow, zero arrowheads.
 *  - Regions render as soft matte architectural zones (glass-soft wash, 1px
 *    var(--border-subtle) rounded rect around their members' bounding box)
 *    with clean editorial sentence-case labels — no glowing circles, no
 *    textShadow. Each label carries a quiet per-region "Tidy" action.
 *  - "Tidy to Moodboard Grid": HUD action (active node's region) + per-region
 *    action, both calling the store action `tidyToMoodboard(regionId)` — the
 *    grid math itself is the pure `computeMoodboardGrid` in lib/moodboard.ts.
 *    External store position changes (tidy, future undo) are detected by a
 *    persisted-position diff and applied through the solver's own input
 *    contract: the re-homed uuids are omitted from the layout input for one
 *    commit (the hook drops their simulations) and restored on the next (the
 *    hook re-creates them exactly at the new persisted homes), so cards land
 *    on their sheet slots with no stale-simulation fight — a clean snap, and
 *    the store, React Flow and the solver agree from then on.
 *  - §6 "never auto-move existing nodes" is enforced at the layout input:
 *    only edges touching an UNSETTLED satellite feed the link force, so
 *    satellites still relax radially near their parents while settled cards
 *    (a tidied moodboard sheet included) are held purely by their home
 *    anchors and never get dragged off-grid by link equilibria.
 *  - Interactions: click → `activateNode` (ghosts delegate to wake), dblclick
 *    → `toggleStack` (§4.5 deck), drag-end → `moveNode({pin:true})`
 *    (drag-to-anchor §6), HUD toggles for semantic-zoom override + physics
 *    Freeze/Relax, quick sticky/region creators, and the Active Workbench
 *    Tray with faint ink tethers back to home regions (§6 gravity well).
 *
 * Design language: dead-neutral matte graphite (canonical tokens in
 * index.css — raw colors never appear in this file), framer-motion springs
 * (stiffness 380 / damping 30), lucide-react icons, clsx + tailwind-merge.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode, RefObject } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { Transition } from 'framer-motion'
import { LayoutGrid, Map as MapIcon, Plus, ScanEye, Snowflake, StickyNote, Volume2, Waves, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  getBezierPath,
  useReactFlow,
  useStore,
  useViewport,
} from '@xyflow/react'
import type { EdgeProps, EdgeTypes, NodeTypes, OnMove, OnMoveEnd, Viewport } from '@xyflow/react'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { useGraphStore } from '../../store/useGraphStore'
import { selectCanvasEdges, selectCanvasNodes, selectRegionList, selectWorkbenchNodes } from '../../store/useGraphStore'
import { useHybridForceLayout } from '../../hooks/useHybridForceLayout'
import type { LayoutLinkInput, LayoutNodeInput, LayoutPositions } from '../../hooks/useHybridForceLayout'
import { lodForZoom } from '../../lib/types'
import type {
  NodeUuid,
  Region,
  RegionId,
  SemanticZoomLevel,
  SpatialCanvasProps,
  SpatialFlowEdge,
  SpatialTabFlowNode,
  SpatialTabNodeRecord,
  ViewMode,
} from '../../lib/types'
import SpatialTabNode from './nodes/SpatialTabNode'
import { CanvasLodContext } from './canvasLodContext'
import type { CanvasLodValue } from './canvasLodContext'

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** §4 collision radius handed to the hybrid layout, per semantic-zoom tier. */
const LOD_RADIUS: Record<SemanticZoomLevel, number> = {
  macro: 14,
  compact: 24,
  rich: 52,
}

/** Sub-epsilon motion is considered static — keeps slow orbit wobble cheap. */
const POSITION_EPSILON_PX = 0.4

/**
 * Echo tolerance for the external-position diff: settle commits and drag-stop
 * commits land within the solver's ±5.5px idle orbit of the last applied
 * render position, so anything inside this band is that echo — not a genuine
 * external re-layout (tidy moves are hundreds of px).
 */
const ECHO_TOLERANCE_PX = 6

/** Max nodes whose position is pushed into React Flow per animation frame. */
const MAX_POSITION_UPDATES_PER_TICK = 40

/** SPEC §2 motion language — snappy springs, never linear. */
const SPRING_TRANSITION: Transition = { type: 'spring', stiffness: 380, damping: 30 }

/** Phase 1.5 card shell footprint used for region bounding boxes. */
const REGION_CARD_SHELL = { width: 260, height: 210 }
/** Matte zone padding around its members' bounding box (world px). */
const REGION_ZONE_PAD = 120
/** Zone corner radius (world px). */
const REGION_ZONE_RADIUS = 24

const NODE_TYPES: NodeTypes = { spatialTab: SpatialTabNode }
const EDGE_TYPES: EdgeTypes = { spatialFlow: SpatialFlowEdgeView }

/**
 * Calm-graph stylesheet. State grammar lives on canonical tokens; the only
 * transitions are short opacity/stroke eases (hover illumination + focus
 * dimming). Zero keyframes — nothing marches, nothing pulses, nothing glows.
 */
const CANVAS_STYLES = `
  .react-flow__node {
    transition: opacity 240ms ease;
  }
  [data-sp-focus='on'] .react-flow__node {
    opacity: 0.25;
  }
  [data-sp-focus='on'] .react-flow__node.sp-hop {
    opacity: 1;
  }
  .sp-edge-line {
    transition: opacity 220ms ease, stroke 220ms ease;
  }
  .sp-region-tidy {
    transition: color 150ms ease, background-color 150ms ease, border-color 150ms ease;
  }
  .sp-region-tidy:hover {
    color: var(--ink-primary);
    background-color: var(--glass-soft);
    border-color: var(--border-hover);
  }
  .sp-region-tidy:active {
    border-color: var(--border-active);
  }
  .react-flow__attribution {
    background: transparent;
  }
  .react-flow__attribution a {
    color: var(--ink-muted);
  }
`

/* ------------------------------------------------------------------ */
/* Hover-focus context (1-hop lineage illumination)                    */
/* ------------------------------------------------------------------ */

/**
 * While a node is hovered: `focusUuid` is that node, `hopUuids` is the node
 * plus its 1-hop neighbours (parent/child lineage), `focusRegionId` its
 * region (null when unregioned). All null when nothing is hovered — the
 * canvas rests at full opacity. Edges and the region layer read this via
 * context; node dimming itself is a single CSS rule keyed off
 * `[data-sp-focus]` on the canvas root, so 700 nodes dim without any
 * per-node JS work.
 */
type CanvasFocus = {
  focusUuid: NodeUuid | null
  hopUuids: Set<NodeUuid> | null
  focusRegionId: RegionId | null
}

const CanvasFocusContext = createContext<CanvasFocus>({ focusUuid: null, hopUuids: null, focusRegionId: null })

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function cn(...inputs: Array<string | false | null | undefined>): string {
  return twMerge(clsx(inputs))
}

/** Matte bounding box for a region: its members' card-shell footprint + pad. */
function regionBox(members: SpatialTabNodeRecord[], region: Region): { x: number; y: number; width: number; height: number } {
  if (members.length === 0) {
    return {
      x: region.center.x - region.radius,
      y: region.center.y - region.radius,
      width: region.radius * 2,
      height: region.radius * 2,
    }
  }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const member of members) {
    minX = Math.min(minX, member.x)
    minY = Math.min(minY, member.y)
    maxX = Math.max(maxX, member.x + REGION_CARD_SHELL.width)
    maxY = Math.max(maxY, member.y + REGION_CARD_SHELL.height)
  }
  return {
    x: minX - REGION_ZONE_PAD,
    y: minY - REGION_ZONE_PAD,
    width: maxX - minX + REGION_ZONE_PAD * 2,
    height: maxY - minY + REGION_ZONE_PAD * 2,
  }
}

/* ------------------------------------------------------------------ */
/* Custom edge — static 1px smooth bezier (Phase 1.5 calm graph)       */
/* ------------------------------------------------------------------ */

/**
 * One static curve for every edge kind. Rest: 1px var(--border-subtle)
 * (≈ rgba(255,255,255,0.07) in dark graphite, a warm hairline in Paper).
 * Hover focus: edges incident to the hovered node illuminate to
 * var(--ink-primary) @ 45% opacity; every other edge dims to 0.25. Both are
 * plain style flips covered by the .sp-edge-line ease — no dash, no glow, no
 * direction markers, no animated overlay path.
 */
function SpatialFlowEdgeView({
  id,
  source,
  target,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
}: EdgeProps<SpatialFlowEdge>) {
  const focus = useContext(CanvasFocusContext)
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    curvature: 0.35,
  })

  const lit = focus.focusUuid !== null && (source === focus.focusUuid || target === focus.focusUuid)
  const dimmed = focus.focusUuid !== null && !lit

  return (
    <BaseEdge
      id={id}
      path={path}
      className="sp-edge-line"
      interactionWidth={12}
      style={{
        stroke: lit ? 'var(--ink-primary)' : 'var(--border-subtle)',
        strokeOpacity: lit ? 0.45 : 1,
        strokeWidth: 1,
        opacity: dimmed ? 0.25 : 1,
      }}
    />
  )
}

/* ------------------------------------------------------------------ */
/* Region zones — soft matte architectural plates (§4.1, §6)           */
/* ------------------------------------------------------------------ */

type RegionZonesLayerProps = {
  regions: Region[]
  membersByRegion: Map<RegionId, SpatialTabNodeRecord[]>
  lod: SemanticZoomLevel
  onTidyRegion: (regionId: RegionId) => void
}

/**
 * Two world-space layers per region: the matte zone plate (z −1, behind
 * edges) and the label plate (z 7, above edges, below cards) carrying the
 * editorial sentence-case name and the quiet per-region Tidy action. Label
 * sizes are divided by the viewport zoom so they hold constant screen size —
 * large high-contrast titles at the macro tier, quiet 12.5px labels above.
 */
function RegionZonesLayer({ regions, membersByRegion, lod, onTidyRegion }: RegionZonesLayerProps) {
  const { zoom } = useViewport()
  const focus = useContext(CanvasFocusContext)

  const boxes = useMemo(
    () => regions.map((region) => ({ region, box: regionBox(membersByRegion.get(region.id) ?? [], region) })),
    [regions, membersByRegion],
  )

  if (boxes.length === 0) return null

  /** World px that render as `v` screen px at the current zoom. */
  const sx = (v: number) => v / zoom
  const macro = lod === 'macro'
  const titleSize = macro ? 30 : 12.5

  return (
    <ViewportPortal>
      {boxes.map(({ region, box }) => {
        const dimmed = focus.focusUuid !== null && focus.focusRegionId !== region.id
        return (
          <div
            key={`zone-${region.id}`}
            style={{
              position: 'absolute',
              left: box.x,
              top: box.y,
              width: box.width,
              height: box.height,
              zIndex: -1,
              borderRadius: REGION_ZONE_RADIUS,
              border: '1px solid var(--border-subtle)',
              background: 'var(--glass-soft)',
              opacity: dimmed ? 0.25 : 1,
              transition: 'opacity 240ms ease',
              pointerEvents: 'none',
            }}
          />
        )
      })}
      {boxes.map(({ region, box }) => {
        const dimmed = focus.focusUuid !== null && focus.focusRegionId !== region.id
        return (
          <div
            key={`label-${region.id}`}
            style={{
              position: 'absolute',
              left: box.x,
              top: box.y,
              zIndex: 7,
              opacity: dimmed ? 0.25 : 1,
              transition: 'opacity 240ms ease',
              pointerEvents: 'none',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: sx(10),
                transform: 'translateY(-100%)',
                paddingBottom: sx(6),
              }}
            >
              <span
                style={{
                  fontSize: sx(titleSize),
                  lineHeight: 1.1,
                  fontWeight: macro ? 600 : 500,
                  letterSpacing: '0.01em',
                  whiteSpace: 'nowrap',
                  color: macro ? 'var(--ink-primary)' : 'var(--ink-secondary)',
                }}
              >
                {region.name}
              </span>
              <button
                type="button"
                className="sp-region-tidy nopan nodrag nowheel"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: sx(5),
                  padding: `${sx(3)} ${sx(8)}`,
                  borderRadius: sx(7),
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--bg-elevated)',
                  color: 'var(--ink-secondary)',
                  fontSize: sx(11),
                  lineHeight: 1,
                  pointerEvents: 'auto',
                  cursor: 'pointer',
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  onTidyRegion(region.id)
                }}
                title={`Tidy "${region.name}" to a moodboard grid — graph edges and pinned anchors are preserved`}
              >
                <LayoutGrid size={sx(11)} strokeWidth={1.75} aria-hidden />
                Tidy
              </button>
            </div>
          </div>
        )
      })}
    </ViewportPortal>
  )
}

/* ------------------------------------------------------------------ */
/* Workbench tether layer — faint ink lines from tray chips to home    */
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
          stroke="var(--ink-muted)"
          strokeWidth={1}
          strokeOpacity={tetherOpacity}
          strokeLinecap="round"
        />
        <circle cx={x2} cy={y2} r={2.5} fill="var(--ink-muted)" fillOpacity={tetherOpacity + 0.2} />
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
  hint?: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
}

/** Quiet HUD toggle — sentence case sans, ink-var states, hairline grammar. */
function HudToggle({ icon: Icon, label, hint, active = false, disabled = false, onClick }: HudToggleProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={hint ?? label}
      className={cn(
        'flex items-center gap-1.5 rounded-lg px-2 py-1.5 transition-colors duration-150',
        active
          ? 'bg-[var(--glass-soft)] text-[color:var(--ink-primary)]'
          : 'text-[color:var(--ink-secondary)] hover:bg-[var(--glass-soft)] hover:text-[color:var(--ink-primary)]',
        disabled && 'pointer-events-none opacity-35',
      )}
    >
      <Icon size={13} strokeWidth={1.75} aria-hidden />
      <span className="text-[11px] leading-none tracking-ui">{label}</span>
      {active ? <span aria-hidden className="h-1 w-1 rounded-full bg-accent" /> : null}
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
            <div className="flex items-center gap-1.5 rounded-xl border border-hairline bg-surface-glass px-2 py-1.5 shadow-[var(--shadow-pop)] backdrop-blur-xl">
              <input
                ref={inputRef}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') submit()
                  else if (event.key === 'Escape') setOpen(false)
                }}
                placeholder="Region name…"
                className="w-44 bg-transparent text-[12px] text-[color:var(--ink-primary)] outline-none placeholder:text-[color:var(--ink-muted)]"
              />
              <button
                type="button"
                onClick={submit}
                title="Create region"
                className="rounded-md bg-[var(--glass-soft)] p-1 text-[color:var(--ink-primary)] transition-colors hover:bg-[var(--border-hover)]"
              >
                <Plus size={12} aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                title="Cancel"
                className="rounded-md p-1 text-[color:var(--ink-secondary)] transition-colors hover:bg-[var(--glass-soft)] hover:text-[color:var(--ink-primary)]"
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
  workbench: SpatialTabNodeRecord[]
  chipElsRef: RefObject<Map<NodeUuid, HTMLElement>>
  activeRegionId: RegionId | null
  onFocusNode: (uuid: NodeUuid) => void
  onQuickNote: () => boolean
  onCreateRegion: (name: string) => void
  onTidyRegion: (regionId: RegionId) => void
}

function HudDock({
  workbench,
  chipElsRef,
  activeRegionId,
  onFocusNode,
  onQuickNote,
  onCreateRegion,
  onTidyRegion,
}: HudDockProps) {
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

  const handleTidyClick = () => {
    if (activeRegionId === null) return
    onTidyRegion(activeRegionId)
  }

  return (
    <div className="absolute bottom-4 left-1/2 z-30 w-max max-w-[94vw] -translate-x-1/2">
      <motion.div
        initial={{ y: 26, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={SPRING_TRANSITION}
        className="flex flex-wrap items-center justify-center gap-1 rounded-2xl border border-hairline bg-surface-glass px-2.5 py-2 shadow-[var(--shadow-pop)] backdrop-blur-xl"
      >
        {/* zoom percentage + current semantic-zoom tier */}
        <div className="flex items-center gap-2 py-0.5 pl-1 pr-1.5">
          <span className="text-[11px] tabular-nums text-[color:var(--ink-primary)]">{Math.round(zoom * 100)}%</span>
          <span className="rounded-md border border-hairline px-1.5 py-0.5 text-[10px] text-[color:var(--ink-muted)]">{lod}</span>
        </div>

        <DockDivider />

        <HudToggle
          icon={ScanEye}
          label="LOD lock"
          hint="Pin the current tier — the wheel stops stepping tiers until you unlock"
          active={override !== null}
          onClick={() => useGraphStore.getState().toggleSemanticZoomOverride()}
        />
        <HudToggle
          icon={frozen ? Waves : Snowflake}
          label={frozen ? 'Relax' : 'Freeze'}
          hint="Stop or resume all canvas physics"
          active={frozen}
          onClick={() => useGraphStore.getState().togglePhysicsFrozen()}
        />

        <DockDivider />

        <HudToggle icon={StickyNote} label="Note" active={noteFlash} disabled={activeUuid === null} onClick={handleQuickNoteClick} />
        <RegionCreator onCreate={onCreateRegion} />

        <DockDivider />

        {/* Tidy to Moodboard Grid — snaps the active node's region into a contact sheet */}
        <HudToggle
          icon={LayoutGrid}
          label="Tidy grid"
          hint="Tidy this region to a moodboard grid — graph edges and pinned anchors are preserved"
          disabled={activeRegionId === null}
          onClick={handleTidyClick}
        />

        <DockDivider />

        {/* Active Workbench Tray — magnetic dock of the 3–5 live tabs (§3, §6) */}
        <div className="flex items-center gap-1.5 pl-1">
          <span className="hidden text-[10px] tracking-ui text-[color:var(--ink-muted)] lg:inline">Workbench</span>
          {workbench.length === 0 ? (
            <span className="px-1.5 text-[10px] text-[color:var(--ink-muted)]">No live tabs</span>
          ) : (
            workbench.map((node) => {
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
                    isActive
                      ? 'border-[var(--border-active)] bg-[var(--glass-soft)]'
                      : 'border-hairline bg-[var(--glass-soft)] hover:border-[var(--border-hover)]',
                  )}
                  style={isActive ? { boxShadow: 'var(--shadow-card)' } : undefined}
                >
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: isActive ? 'var(--accent)' : 'var(--ink-muted)' }}
                  />
                  <span className="truncate text-[10.5px] font-medium leading-none text-[color:var(--ink-primary)]">
                    {node.title}
                  </span>
                  {node.isAudible ? <Volume2 size={11} className="shrink-0 text-[color:var(--ink-secondary)]" aria-hidden /> : null}
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

  const { setNodes, setCenter, screenToFlowPosition, getNodes, getViewport, fitView } =
    useReactFlow<SpatialTabFlowNode, SpatialFlowEdge>()

  /* Imperative frame buffers — mutated in place, never React state. */
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chipElsRef = useRef<Map<NodeUuid, HTMLElement>>(new Map())
  const draggingUuidsRef = useRef<Set<NodeUuid>>(new Set())
  /** Last position actually applied to React Flow (epsilon/coalescing bookkeeping). */
  const lastAppliedRef = useRef<LayoutPositions>({})
  /** Last persisted (store) position seen per uuid — detects external moves (tidy). */
  const persistedPosRef = useRef<Map<NodeUuid, { x: number; y: number }>>(new Map())
  const prevViewModeRef = useRef<ViewMode | null>(null)

  const lod = lodForZoom(zoom, semanticZoomOverride)
  const lodValue = useMemo<CanvasLodValue>(() => ({ lod }), [lod])

  /* Macro-tier beacon counter-scale (audit round 2, §1.7): inside the
     0.15–0.35 macro band the 24 px beacons otherwise shrink to sub-pixel
     specks. Inverse-scaling holds a ~constant ~10 px on-screen footprint.
     Applied as a CSS custom property on the canvas root, so all beacons
     rescale through pure CSS inheritance — zero per-node re-renders. */
  const beaconScale = lod === 'macro' ? Math.min(3, Math.max(1, 0.5 / zoom)) : 1

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

  const membersByRegion = useMemo(() => {
    const map = new Map<RegionId, SpatialTabNodeRecord[]>()
    for (const node of canvasNodes) {
      if (!node.regionId) continue
      const list = map.get(node.regionId)
      if (list) list.push(node)
      else map.set(node.regionId, [node])
    }
    return map
  }, [canvasNodes])

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

  /* ---- hover-focus (1-hop lineage illumination) ---- */
  const [focusUuid, setFocusUuid] = useState<NodeUuid | null>(null)

  const adjacencyByUuid = useMemo(() => {
    const map = new Map<NodeUuid, Set<NodeUuid>>()
    for (const edge of canvasEdges) {
      let sources = map.get(edge.source)
      if (!sources) {
        sources = new Set<NodeUuid>()
        map.set(edge.source, sources)
      }
      sources.add(edge.target)
      let targets = map.get(edge.target)
      if (!targets) {
        targets = new Set<NodeUuid>()
        map.set(edge.target, targets)
      }
      targets.add(edge.source)
    }
    return map
  }, [canvasEdges])

  const hopUuids = useMemo(() => {
    if (!focusUuid) return null
    const hops = new Set<NodeUuid>([focusUuid])
    const direct = adjacencyByUuid.get(focusUuid)
    if (direct) for (const uuid of direct) hops.add(uuid)
    return hops
  }, [focusUuid, adjacencyByUuid])

  const focusRegionId = focusUuid ? (nodesRecord[focusUuid]?.regionId ?? null) : null

  const focusValue = useMemo<CanvasFocus>(
    () => ({ focusUuid, hopUuids, focusRegionId }),
    [focusUuid, hopUuids, focusRegionId],
  )

  /* Hybrid physics inputs — persisted home coordinates (never the orbit-wobbled
     render positions, so §6 "never auto-move existing nodes" holds).
     `rehomeUuids`: externally re-positioned cards (tidy to moodboard grid) are
     omitted from the layout input for exactly one commit — the solver drops
     their simulations — and restored on the next, which re-creates them
     precisely at their new persisted homes. This is the only way existing
     simulations can be re-homed through the hook's input contract without a
     stale-simulation fight. */
  const [rehomeUuids, setRehomeUuids] = useState<Set<NodeUuid> | null>(null)

  const layoutNodes = useMemo<LayoutNodeInput[]>(
    () =>
      canvasNodes
        .filter((node) => !rehomeUuids?.has(node.uuid))
        .map((node) => ({
          uuid: node.uuid,
          x: node.x,
          y: node.y,
          fx: node.fx,
          fy: node.fy,
          isNew: !node.settled,
          radius: LOD_RADIUS[lod],
        })),
    [canvasNodes, lod, rehomeUuids],
  )

  /* §6 — the link force exists to place NEW satellites near their parents;
     links among settled cards are inert so home anchors own the layout (a
     tidied moodboard sheet is never dragged off-grid by link equilibria). */
  const unsettledUuids = useMemo(
    () => new Set(canvasNodes.filter((node) => !node.settled).map((node) => node.uuid)),
    [canvasNodes],
  )
  const layoutLinks = useMemo<LayoutLinkInput[]>(
    () =>
      canvasEdges
        .filter((edge) => unsettledUuids.has(edge.source) || unsettledUuids.has(edge.target))
        .map((edge) => ({ source: edge.source, target: edge.target, weight: edge.weight })),
    [canvasEdges, unsettledUuids],
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

  /* ---- external position changes → re-home through the solver ----
     The store owns persisted positions; when something other than a drag or a
     settle commit rewrites them (the `tidyToMoodboard` moodboard grid, future
     undo/redo), re-home the affected cards: clear their applied-position
     buffer (the next render bakes the store position) and omit them from the
     layout input for one commit so the solver re-creates their simulations
     exactly at the new homes. The solver, React Flow and the store agree
     from then on — no stale-simulation fight, and the re-home is one clean
     snap into the sheet. Drag-stop and settle commits echo the position
     already applied to React Flow (epsilon-equal), so they are skipped. */
  useEffect(() => {
    const present = new Set<NodeUuid>()
    const changedUuids: NodeUuid[] = []
    for (const node of canvasNodes) {
      present.add(node.uuid)
      const previous = persistedPosRef.current.get(node.uuid)
      if (!previous) {
        // First sighting (spawn, ghost materialize): the hook initializes the
        // simulation at this home and the render bake uses it — nothing to do.
        persistedPosRef.current.set(node.uuid, { x: node.x, y: node.y })
        continue
      }
      if (previous.x !== node.x || previous.y !== node.y) {
        persistedPosRef.current.set(node.uuid, { x: node.x, y: node.y })
        if (!draggingUuidsRef.current.has(node.uuid)) changedUuids.push(node.uuid)
      }
    }
    for (const uuid of [...persistedPosRef.current.keys()]) {
      if (!present.has(uuid)) {
        persistedPosRef.current.delete(uuid)
        delete lastAppliedRef.current[uuid]
      }
    }
    if (changedUuids.length === 0) return

    // Drag-stop and settle commits echo the position already applied to React
    // Flow (within the idle orbit band) — skip them. Anything else (tidy to
    // moodboard grid, future undo) is a real re-layout: re-home the cards
    // through the solver's input.
    const allEcho = changedUuids.every((uuid) => {
      const applied = lastAppliedRef.current[uuid]
      if (!applied) return false
      const persisted = persistedPosRef.current.get(uuid)
      if (!persisted) return true
      return (
        Math.abs(applied.x - persisted.x) <= ECHO_TOLERANCE_PX &&
        Math.abs(applied.y - persisted.y) <= ECHO_TOLERANCE_PX
      )
    })
    if (allEcho) return

    for (const uuid of changedUuids) delete lastAppliedRef.current[uuid]
    setRehomeUuids(new Set(changedUuids))
  }, [canvasNodes])

  /* Restore the re-homed cards on the commit after their omission: the solver
     re-creates their simulations at the new persisted homes. Runs after the
     hook's own sync effect (declared later in this component). */
  useEffect(() => {
    if (rehomeUuids) setRehomeUuids(null)
  }, [rehomeUuids])

  /* ---- store → React Flow elements ---- */
  /* The §4 LOD tier deliberately does NOT ride in node data: baking it there
     would rebuild every node object in the graph on each tier crossing and
     push them through React Flow's internal store — the exact pipeline that
     intermittently wedged under the 700-node seed (audit round 1, V1). The
     tier flows through CanvasLodContext instead, re-rendering only the
     mounted card components; this memo stays identity-stable across
     crossings, so RF's node store is not churned by zooming at all. */
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
        // Hover-focus dimming: lit 1-hop lineage keeps full opacity, everything
        // else dims through the single [data-sp-focus] CSS rule.
        className: hopUuids ? (hopUuids.has(node.uuid) ? 'sp-hop' : undefined) : undefined,
        data: {
          node,
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
  }, [canvasNodes, regionsRecord, activeNodeUuid, workbenchSet, derivedCounts, collapsedSet, hopUuids, rehomeUuids])

  const flowEdges = useMemo<SpatialFlowEdge[]>(
    () =>
      canvasEdges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'spatialFlow',
        data: { kind: edge.kind, weight: edge.weight },
        zIndex: 2,
      })),
    [canvasEdges],
  )

  /* ---- viewport / interaction wiring ---- */
  /* d3-zoom emits an event per wheel tick; writing the zustand store on each
     one re-renders the canvas root and — worse — synchronously serializes the
     whole persisted world (hundreds of KB at /seed-700) per event. Coalesce
     to at most one write per animation frame, and skip the write entirely
     unless the displayed percentage or the §4 LOD tier would actually change.
     Tier boundaries sit exactly on integer percents (35%/65%), so the tier
     check is what keeps a boundary crossing inside one displayed percent
     from stalling the LOD switch. */
  const pendingZoomRef = useRef<number | null>(null)
  const zoomWriteFrameRef = useRef<number | null>(null)

  const writeZoom = useCallback((raw: number) => {
    const state = useGraphStore.getState()
    const current = state.zoom
    const clamped = Math.min(2, Math.max(0.15, raw))
    if (
      Math.round(current * 100) === Math.round(clamped * 100) &&
      lodForZoom(clamped, state.semanticZoomOverride) === lodForZoom(current, state.semanticZoomOverride)
    ) {
      return
    }
    state.setZoom(clamped)
  }, [])

  const flushPendingZoom = useCallback(() => {
    if (zoomWriteFrameRef.current !== null) {
      cancelAnimationFrame(zoomWriteFrameRef.current)
      zoomWriteFrameRef.current = null
    }
    const pending = pendingZoomRef.current
    pendingZoomRef.current = null
    if (pending !== null) writeZoom(pending)
  }, [writeZoom])

  const handleMove = useCallback<OnMove>(
    (_event, viewport: Viewport) => {
      pendingZoomRef.current = viewport.zoom
      if (zoomWriteFrameRef.current !== null) return
      zoomWriteFrameRef.current = requestAnimationFrame(() => {
        zoomWriteFrameRef.current = null
        const next = pendingZoomRef.current
        pendingZoomRef.current = null
        if (next === null) return
        writeZoom(next)
      })
    },
    [writeZoom],
  )

  /* Gesture end commits the final camera zoom synchronously — no rAF
     dependency, so the HUD percentage and the §4 LOD tier converge with the
     live camera even on hosts that suspend frame scheduling between events
     (audit round 2, §3.5). */
  const handleMoveEnd = useCallback<OnMoveEnd>(() => flushPendingZoom(), [flushPendingZoom])

  // Cancel a pending coalesced write when the canvas unmounts.
  useEffect(
    () => () => {
      if (zoomWriteFrameRef.current !== null) cancelAnimationFrame(zoomWriteFrameRef.current)
    },
    [],
  )

  /* Zoom divergence watchdog — the audit's V1 end state was React Flow's
     live viewport advancing while the store zoom (HUD %, LOD tier) stayed
     pinned. If the onMove → setZoom pipeline ever drops writes again, this
     re-syncs the store from the live viewport after two consecutive
     divergent samples instead of deadlocking the tier and HUD. */
  useEffect(() => {
    if (viewMode !== 'canvas') return
    let divergent = 0
    const timer = window.setInterval(() => {
      const rfZoom = getViewport().zoom
      const storeZoom = useGraphStore.getState().zoom
      if (Math.abs(rfZoom - storeZoom) > 0.004) {
        divergent += 1
        if (divergent >= 2) {
          divergent = 0
          useGraphStore.getState().setZoom(Math.min(2, Math.max(0.15, rfZoom)))
        }
      } else {
        divergent = 0
      }
    }, 800)
    return () => window.clearInterval(timer)
  }, [viewMode, getViewport])

  const handleNodeClick = useCallback((_event: ReactMouseEvent, node: SpatialTabFlowNode) => {
    useGraphStore.getState().activateNode(node.id)
  }, [])

  const handleNodeDoubleClick = useCallback((_event: ReactMouseEvent, node: SpatialTabFlowNode) => {
    useGraphStore.getState().toggleStack(node.id)
  }, [])

  const handleNodeMouseEnter = useCallback((_event: ReactMouseEvent, node: SpatialTabFlowNode) => {
    setFocusUuid(node.id)
  }, [])

  const handleNodeMouseLeave = useCallback(() => setFocusUuid(null), [])

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

  /* ---- HUD / region actions ---- */
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

  /** "Tidy to Moodboard Grid" — HUD + per-region entry point. The grid math
   * itself is the pure `computeMoodboardGrid` in lib/moodboard.ts; the store
   * action applies the returned slots without touching any graph edge. */
  const handleTidyRegion = useCallback((regionId: RegionId) => {
    useGraphStore.getState().tidyToMoodboard(regionId)
  }, [])

  const activeRegionId = activeNodeUuid ? (nodesRecord[activeNodeUuid]?.regionId ?? null) : null

  /* Entering canvas mode: land the camera on the active node as soon as the
     React Flow instance exists WITH measured pane dimensions (audit round 2,
     §1.5: a resumed / identity-camera entry showed an empty canvas). Keyed on
     the panZoom instance + measured size — not a viewMode transition — so the
     camera re-lands whenever React Flow (re)creates its zoom engine
     (StrictMode's simulated remount in dev recreates it at the identity
     defaultViewport AFTER transition-keyed effects run; this re-lands on it).
     The zoom at landing is the store zoom — /seed-700 intentionally arrives
     at 0.3 (macro demo). With no active node at all, fitView frames the whole
     graph instead of leaving an identity camera on empty space. */
  const cameraReady = useStore((state) => (state.panZoom && state.width > 0 && state.height > 0 ? state.panZoom : null))

  /** Land the camera on the active node at the store zoom (duration 0), or —
   * with no active node — fitView the whole graph. Synchronous; used for
   * canvas entry AND for world replacement (a seed) while the canvas is open. */
  const landCameraOnActive = useCallback(() => {
    const state = useGraphStore.getState()
    const node = state.activeNodeUuid ? state.nodes[state.activeNodeUuid] : undefined
    if (!node) {
      void fitView({ duration: 0, padding: 0.3 })
      return
    }
    const flowNode = getNodes().find((n) => n.id === node.uuid)
    const x = flowNode?.position.x ?? node.x
    const y = flowNode?.position.y ?? node.y
    // Center the card's body, not its top-left origin.
    const w = flowNode?.measured?.width ?? REGION_CARD_SHELL.width
    const h = flowNode?.measured?.height ?? REGION_CARD_SHELL.height
    setCenter(x + w / 2, y + h / 2, { zoom: state.zoom, duration: 0 })
  }, [fitView, getNodes, setCenter])

  useEffect(() => {
    if (viewMode !== 'canvas' || !cameraReady) return
    landCameraOnActive()
  }, [cameraReady, viewMode, landCameraOnActive])

  /* A seed replaces the whole world (nodes, regions, zoom) and may run while
     the canvas is already open — re-land the camera so the seeded zoom tier is
     actually on screen (otherwise the zoom-divergence watchdog would read the
     stale camera and silently undo the seeded zoom). */
  const seededVersion = useGraphStore((state) => state.seededVersion)
  const prevSeedVersionRef = useRef(seededVersion)
  useEffect(() => {
    if (prevSeedVersionRef.current === seededVersion) return
    prevSeedVersionRef.current = seededVersion
    if (viewMode === 'canvas') landCameraOnActive()
  }, [seededVersion, viewMode, landCameraOnActive])

  /* Entry chase: while the d3-force layout is still converging right after
     entering canvas mode, keep the active node centered until it stabilizes
     (or 4s elapse), then lock the camera. */
  useEffect(() => {
    const enteredCanvas = prevViewModeRef.current !== viewMode && viewMode === 'canvas'
    prevViewModeRef.current = viewMode
    if (!enteredCanvas) return
    const node = useGraphStore.getState().activeNodeUuid
    if (!node || !useGraphStore.getState().nodes[node]) return
    let last: { x: number; y: number } | null = null
    let stableTicks = 0
    const startedAt = performance.now()
    const timer = window.setInterval(() => {
      const record = useGraphStore.getState().nodes[node]
      if (!record) {
        window.clearInterval(timer)
        return
      }
      const flowNode = getNodes().find((n) => n.id === node)
      const x = flowNode?.position.x ?? record.x
      const y = flowNode?.position.y ?? record.y
      if (last && Math.abs(last.x - x) < 0.5 && Math.abs(last.y - y) < 0.5) stableTicks += 1
      else stableTicks = 0
      last = { x, y }
      // Center the card's body, not its top-left origin.
      const w = flowNode?.measured?.width ?? REGION_CARD_SHELL.width
      const h = flowNode?.measured?.height ?? REGION_CARD_SHELL.height
      const settled = stableTicks >= 2 || performance.now() - startedAt > 4000
      setCenter(x + w / 2, y + h / 2, { zoom: useGraphStore.getState().zoom, duration: settled ? 450 : 260 })
      if (settled) window.clearInterval(timer)
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
          data-sp-focus={focusUuid !== null ? 'on' : 'off'}
          style={{ '--stn-beacon-scale': beaconScale } as CSSProperties}
        >
          <style>{CANVAS_STYLES}</style>
          <CanvasLodContext.Provider value={lodValue}>
          <CanvasFocusContext.Provider value={focusValue}>
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
                onMoveEnd={handleMoveEnd}
                onNodeClick={handleNodeClick}
                onNodeDoubleClick={handleNodeDoubleClick}
                onNodeMouseEnter={handleNodeMouseEnter}
                onNodeMouseLeave={handleNodeMouseLeave}
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
                  bgColor="var(--bg-canvas)"
                  color="var(--grid-dot)"
                  gap={26}
                  size={1.4}
                />
                <RegionZonesLayer regions={regionsList} membersByRegion={membersByRegion} lod={lod} onTidyRegion={handleTidyRegion} />
              </ReactFlow>

              {/* Soft vignette — the dot-matrix grid fades into the canvas void (theme-aware) */}
              <div
                className="pointer-events-none absolute inset-0 z-[5]"
                style={{
                  background:
                    'radial-gradient(ellipse 90% 80% at 50% 45%, transparent 55%, color-mix(in srgb, var(--bg-canvas) 62%, transparent) 100%)',
                }}
              />

              <WorkbenchTetherLayer
                containerRef={containerRef}
                chipElsRef={chipElsRef}
                workbench={workbenchNodes}
                regions={regionsList}
              />

              <HudDock
                workbench={workbenchNodes}
                chipElsRef={chipElsRef}
                activeRegionId={activeRegionId}
                onFocusNode={handleFocusNode}
                onQuickNote={handleQuickNote}
                onCreateRegion={handleCreateRegion}
                onTidyRegion={handleTidyRegion}
              />
            </div>
          </CanvasFocusContext.Provider>
          </CanvasLodContext.Provider>
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
