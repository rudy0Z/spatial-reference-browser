/**
 * app/src/components/chrome/FloatingIslandPill.tsx — the 3-Stage Island
 * Continuum (SPEC ADDENDUM B §B.1–B.5, Phase 3.2 "Stage C").
 *
 * STAGE 0 — resting island pill (Blanc geometry, top-center, 36px): Back /
 * Forward + up to 6 Smart Relational Dots (`selectPillNeighbours` — came-from
 * parent, live siblings, high-confidence Ghost Echoes ≥ 0.78) with the
 * dot-morph hover: a dot springs (stiffness 380 / damping 30) into that
 * tab's 16px favicon and drops a ~232px Visual Peek Card — 16:10 cached
 * preview, full title, domain, and the WHY line in `var(--ink-muted)`
 * (`Branched from Are.na · Live` / `Sleeping · 0 MB`). Center favicon+domain
 * trigger opens Stage 1 (⌘/Ctrl+L opens with the omnibox focused). Right
 * cluster: +, Adblock Shield, ↻, Pin/Heart anchor, ×.
 *
 * STAGE 1 — dual-horizon island deck: the same shell morphs via
 * `layoutId="floating-island"` into a 480px (compact) / 760px (deck) matte
 * popover (`var(--bg-elevated)`, `var(--shadow-pop)`, rounded-[20px]).
 * ELASTIC DISCLOSURE (§B.4): ≤ 8 nodes AND nothing hibernated → Blanc-minimal
 * compact layout (omnibox + vertical open-tab list with 1-level branch
 * indent + utility row); otherwise the dual-horizon deck of §B.2 — header
 * omnibox (URL / search / !bang / /command), Horizon 1 Active Working
 * Session strip (per-pill ☾ park), Horizon 2 Sleeping Visual Archive
 * (region chips incl. Ghost Echoes + Notes, 3–4 col 16:10 bento scrub grid,
 * in-place stack scrubbing with +N badge + segmented scrub bar, 1-hop
 * lineage hairlines, `via "Parent Title"` provenance, click wakes + closes),
 * footer utility dock. Opening/closing is a pure store-flag flip — the
 * main-process WebContentsView Z-Order Guard engages from the same flag
 * (spatialBridge.ts syncGuard), exactly as Stage B built it.
 *
 * STAGE 2 — full continuum: the primary Canvas button, ⌘/Ctrl+Space, or a
 * pinch-out on the deck hands over to the full SpatialCanvas; the pill stays
 * anchored top-center in Mode B — one anchor across the whole browser.
 *
 * SATELLITE FLOW NOTCHES (§B.5): with ≥ 2 active Flows (or a pinned Flow),
 * 32px pills flank the island — 6px `region.color` dot + Flow name + count.
 * Hover opens a 320px mini-tree popover; clicking a node wakes it without
 * hiding other Flows; clicking the pill title pans Mode B to that Flow.
 *
 * DRAG-TO-ANCHOR (§6): both shells are drop targets for `SPATIAL_DRAG_MIME`
 * payloads; a valid drop spawns a live satellite beside the active node.
 *
 * Anti-slop laws hold everywhere: matte graphite only, silent state grammar
 * (filled = live, hollow = asleep, frosted wash = Ghost Echo), one spring,
 * no neon, no uppercase badges. The Shield shows a number ONLY when the App
 * hands one over — never a fabricated count.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Boxes,
  Columns2,
  Download,
  Eraser,
  ExternalLink,
  Globe,
  Heart,
  History,
  LayoutGrid,
  Lock,
  Maximize2,
  Moon,
  PanelTop,
  Plus,
  Puzzle,
  RotateCw,
  Search,
  ShieldCheck,
  StickyNote,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { PreviewArt, previewSpecForNode } from '../canvas/nodes/PreviewArt'
import { spatialApi } from '../../lib/spatialBridge'
import {
  SLASH_COMMANDS,
  SPATIAL_DRAG_MIME,
  domainOf,
  formatRamMb,
  resolveOmniboxEntry,
} from '../../lib/types'
import type {
  FlowNotch,
  FlowTreeRow,
  FloatingIslandPillProps,
  OmniboxEntry,
  PillNeighborDot,
  SearchResult,
  SearchResultKind,
  SlashCommand,
  SlashCommandId,
  SpatialDragPayload,
  SpatialTabNodeRecord,
} from '../../lib/types'
import {
  IDLE_SWEEP_INTERVAL_MS,
  selectChildren,
  selectFlowNotches,
  selectFlowTreeRows,
  selectHibernatedCount,
  selectPillNeighbours,
  selectSearchResults,
  selectTotalNodeCount,
  useGraphStore,
} from '../../store/useGraphStore'
import type { GraphStore } from '../../store/useGraphStore'

/* ------------------------------------------------------------------ */
/* Local styling helpers (clsx + tailwind-merge per SPEC §1)           */
/* ------------------------------------------------------------------ */

function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** §2 motion language — one spring everywhere, never linear. */
const SPRING = { type: 'spring', stiffness: 380, damping: 30 } as const

/**
 * The pure store selectors are typed against the full `GraphStore`, but this
 * file subscribes to the record maps they actually read. This adapter lets
 * the memos run on the subscribed slices (kept reactive through the same
 * deps) without calling `useGraphStore.getState()` inside render.
 */
type SelectorStateCore = Partial<
  Pick<GraphStore, 'nodes' | 'edges' | 'notes' | 'voiceMemos' | 'regions' | 'activeNodeUuid' | 'workbenchUuids'>
>

function asSelectorState(core: SelectorStateCore): GraphStore {
  return core as unknown as GraphStore
}

function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'rounded border border-hairline bg-[color:var(--glass-soft)] px-1 font-mono text-[9px] leading-[15px] text-[color:var(--ink-muted)]',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

/** Neutral favicon mark — the chrome owns no hue (thumbnails own the color). */
function FaviconMark({ domain, size = 20 }: { domain: string; size?: number }) {
  const letter = (domain[0] ?? '?').toUpperCase()
  return (
    <span
      style={{ width: size, height: size, fontSize: Math.round(size * 0.44) }}
      className="flex shrink-0 items-center justify-center rounded-md border border-hairline bg-[color:var(--glass-soft)] font-semibold text-[color:var(--ink-secondary)]"
    >
      {letter}
    </span>
  )
}

/** Quiet icon button shared by the pill cluster, deck header and dock. */
function QuietButton({
  icon: Icon,
  label,
  onClick,
  active = false,
  disabled = false,
  size = 13,
  className,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
  active?: boolean
  disabled?: boolean
  size?: number
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-full transition-colors duration-150',
        active
          ? 'bg-[color:var(--glass-soft)] text-[color:var(--ink-primary)] shadow-[inset_0_0_0_1px_var(--border-active)]'
          : 'text-[color:var(--ink-secondary)] hover:bg-[color:var(--glass-soft)] hover:text-[color:var(--ink-primary)]',
        disabled && 'pointer-events-none opacity-35',
        className,
      )}
    >
      <Icon size={size} strokeWidth={1.75} aria-hidden />
    </button>
  )
}

/** Status text of a node for the peek card WHY line (§B.1). */
function statusLineOf(node: SpatialTabNodeRecord): string {
  if (node.isLoading) return 'Loading'
  return node.ramState === 'live' ? 'Live' : `Sleeping · ${formatRamMb(node.ramMb)}`
}

/* ------------------------------------------------------------------ */
/* §B.1 Visual Peek Card — the WHY, not just the what                   */
/* ------------------------------------------------------------------ */

function VisualPeekCard({
  node,
  relationshipLabel,
  align,
  onOpen,
}: {
  node: SpatialTabNodeRecord
  relationshipLabel: string
  align: 'left' | 'center' | 'right'
  onOpen: (uuid: string) => void
}) {
  const alignClass =
    align === 'left' ? 'left-0' : align === 'right' ? 'right-0' : 'left-1/2 -translate-x-1/2'
  return (
    <motion.div
      /* pt-2 keeps the hover area continuous with the dot above it */
      className={`pointer-events-auto absolute top-full z-40 w-[232px] pt-2 ${alignClass}`}
      initial={{ opacity: 0, y: -4, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.97 }}
      transition={SPRING}
    >
      <div
        role="tooltip"
        onClick={() => onOpen(node.uuid)}
        className="cursor-pointer overflow-hidden rounded-[14px] border border-hairline p-1.5"
        style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-pop)' }}
      >
        {/* 16:10 cached preview — even asleep at 0 MB the card keeps its art */}
        <div className="relative aspect-[16/10] w-full overflow-hidden rounded-[10px] border border-hairline bg-[color:var(--glass-soft)]">
          <PreviewArt spec={previewSpecForNode(node)} className="absolute inset-0" />
          {node.ramState !== 'live' && (
            <span className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded-full border border-hairline bg-[color:var(--bg-elevated)] px-1.5 py-0.5 text-[9px] text-[color:var(--ink-muted)]">
              <Moon size={8} strokeWidth={1.75} aria-hidden />
              {formatRamMb(node.ramMb)}
            </span>
          )}
        </div>
        <div className="px-1 pb-0.5 pt-1.5">
          <p className="line-clamp-2 text-[12px] font-medium leading-snug text-[color:var(--ink-primary)]">
            {node.title}
          </p>
          <p className="truncate text-[10.5px] text-[color:var(--ink-muted)]">{node.domain}</p>
          <p className="truncate pt-0.5 text-[10.5px] text-[color:var(--ink-muted)]">
            {relationshipLabel} · {statusLineOf(node)}
          </p>
        </div>
      </div>
    </motion.div>
  )
}

/* ------------------------------------------------------------------ */
/* §B.1 Smart Relational Dots — dot-morph hover (spring 380 / 30)       */
/*   silent state grammar: filled = live, hollow = asleep,             */
/*   frosted wash = Ghost Echo.                                        */
/* ------------------------------------------------------------------ */

const DOT_CORE: Record<PillNeighborDot['state'], string> = {
  loading: 'bg-[color:var(--accent)]',
  live: 'bg-[color:var(--ink-secondary)]',
  hibernated: 'border-[1.5px] border-[color:var(--ink-muted)] bg-transparent',
  ghost: 'border border-[color:var(--ink-muted)] bg-[color:var(--glass-soft)]',
}

const DOT_LABEL: Record<PillNeighborDot['state'], string> = {
  loading: 'Loading…',
  live: 'Live tab',
  hibernated: 'Asleep — click to wake',
  ghost: 'Ghost echo — predicted resurfacing',
}

function NeighborDot({
  dot,
  index,
  total,
  node,
  onActivate,
}: {
  dot: PillNeighborDot
  index: number
  total: number
  node: SpatialTabNodeRecord | null
  onActivate: (uuid: string) => void
}) {
  const [hovered, setHovered] = useState(false)
  const align: 'left' | 'center' | 'right' = index <= 1 && index < total - 2 ? 'left' : index >= total - 2 ? 'right' : 'center'
  return (
    <motion.div
      className="relative flex h-6 items-center"
      onHoverStart={() => setHovered(true)}
      onHoverEnd={() => setHovered(false)}
    >
      <motion.button
        type="button"
        title={`${dot.title} — ${DOT_LABEL[dot.state]}`}
        onClick={() => onActivate(dot.uuid)}
        aria-label={`${dot.title} — ${DOT_LABEL[dot.state]}`}
        /* constant 16px hit area; the mark inside springs dot ⇄ favicon */
        className="flex h-4 w-4 items-center justify-center"
      >
        <motion.span
          className={cn(
            'flex items-center justify-center overflow-hidden rounded-md font-semibold',
            hovered ? 'border border-hairline bg-[color:var(--glass-soft)] text-[color:var(--ink-secondary)]' : DOT_CORE[dot.state],
          )}
          initial={false}
          animate={{
            width: hovered ? 16 : 8,
            height: hovered ? 16 : 8,
            borderRadius: hovered ? 5 : 999,
            opacity: dot.state === 'loading' && !hovered ? [1, 0.4, 1] : 1,
          }}
          transition={{
            ...SPRING,
            opacity: dot.state === 'loading' && !hovered
              ? { duration: 1.05, repeat: Infinity, ease: 'easeInOut' }
              : SPRING,
          }}
        >
          {hovered && (
            <motion.span
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={SPRING}
              className="text-[8px] leading-none"
            >
              {(node?.domain?.[0] ?? dot.title[0] ?? '?').toUpperCase()}
            </motion.span>
          )}
        </motion.span>
      </motion.button>
      <AnimatePresence>
        {hovered && node && (
          <VisualPeekCard
            key={`peek-${dot.uuid}`}
            node={node}
            relationshipLabel={dot.relationshipLabel}
            align={align}
            onOpen={onActivate}
          />
        )}
      </AnimatePresence>
    </motion.div>
  )
}

/* ------------------------------------------------------------------ */
/* Omnibox result rows (slash commands + fuzzy search + URL/bang)       */
/* ------------------------------------------------------------------ */

type OmniboxItem =
  | { type: 'command'; command: SlashCommand }
  | { type: 'result'; result: SearchResult }
  | { type: 'go'; url: string; title: string; detail: string }

const COMMAND_ICONS: Record<SlashCommandId, LucideIcon> = {
  canvas: LayoutGrid,
  park: Moon,
  new: Plus,
  note: StickyNote,
  cluster: Boxes,
  sandbox: ShieldCheck,
  mods: Puzzle,
  zap: Eraser,
}

/** Quiet sentence-case result categories — no uppercase mono chips. */
const RESULT_META: Record<SearchResultKind, { icon: LucideIcon; label: string }> = {
  tab: { icon: PanelTop, label: 'Tab' },
  note: { icon: StickyNote, label: 'Note' },
  memo: { icon: AudioLines, label: 'Memo' },
}

function OmniboxRow({
  selected,
  onSelect,
  onRun,
  icon: Icon,
  title,
  detail,
  chip,
}: {
  selected: boolean
  onSelect: () => void
  onRun: () => void
  icon: LucideIcon
  title: string
  detail: string
  chip: string | null
}) {
  return (
    <button
      type="button"
      data-selected={selected}
      onClick={onRun}
      onMouseEnter={onSelect}
      className="relative flex h-9 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left"
    >
      {selected && (
        <motion.span
          layoutId="floating-island-selection"
          className="absolute inset-0 rounded-[10px] bg-[color:var(--glass-soft)]"
          transition={SPRING}
        />
      )}
      <span className="relative z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border border-hairline bg-[color:var(--glass-soft)] text-[color:var(--ink-secondary)]">
        <Icon size={11} />
      </span>
      <span className="relative z-10 min-w-0 flex-1 truncate text-[12.5px] text-[color:var(--ink-primary)]">{title}</span>
      {detail !== '' && (
        <span className="relative z-10 hidden max-w-[45%] shrink truncate text-[10.5px] text-[color:var(--ink-muted)] sm:block">
          {detail}
        </span>
      )}
      {chip !== null && <span className="relative z-10 shrink-0 text-[10px] text-[color:var(--ink-muted)]">{chip}</span>}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* §6 drag-to-anchor — pill ⇄ reader contract                           */
/* ------------------------------------------------------------------ */

/** Drag handlers shared by the resting pill shell and the deck shell. */
type ShellDragHandlers = {
  onDragEnter: (event: ReactDragEvent) => void
  onDragOver: (event: ReactDragEvent) => void
  onDragLeave: (event: ReactDragEvent) => void
  onDrop: (event: ReactDragEvent) => void
}

/** Prefers the typed `SPATIAL_DRAG_MIME` JSON payload; falls back to native link/text drags. */
function parseSpatialDrop(dataTransfer: DataTransfer): SpatialDragPayload | null {
  const raw = dataTransfer.getData(SPATIAL_DRAG_MIME)
  if (raw !== '') {
    try {
      const parsed = JSON.parse(raw) as Partial<SpatialDragPayload>
      if (typeof parsed.url === 'string' && parsed.url !== '') {
        return {
          url: parsed.url,
          title: typeof parsed.title === 'string' && parsed.title !== '' ? parsed.title : domainOf(parsed.url),
          searchQuery:
            typeof parsed.searchQuery === 'string' && parsed.searchQuery !== '' ? parsed.searchQuery : undefined,
        }
      }
    } catch {
      // Malformed JSON payload — fall through to plain-text link handling (§6).
    }
  }
  for (const text of [dataTransfer.getData('text/uri-list'), dataTransfer.getData('text/plain')]) {
    const candidate = text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '' && !line.startsWith('#'))
    if (!candidate) continue
    try {
      const url = new URL(candidate)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
      return { url: url.toString(), title: domainOf(url.toString()) }
    } catch {
      // Not a URL — keep scanning remaining candidates.
    }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* STAGE 1 — the island deck (shared shell for compact + expanded)      */
/* ------------------------------------------------------------------ */

type DeckNav = {
  canBack: boolean
  canForward: boolean
  onBack: () => void
  onForward: () => void
  onReload: () => void
  onToggleSplit: (() => void) | null
  onToggleExtensions: (() => void) | null
}

function runSlashCommand(
  id: SlashCommandId,
  nav: DeckNav,
  actions: {
    setPaletteOpen: (open: boolean) => void
    toggleCanvas: () => void
    quickNoteOnActive: () => unknown
    parkSessionToArchive: () => number
    createNewTab: (init?: { title?: string; url?: string; partition?: 'default' | 'sandbox' }) => string
    createClusterFromActive: () => unknown
    zapToggle: () => void
  },
) {
  switch (id) {
    case 'canvas':
      actions.toggleCanvas()
      actions.setPaletteOpen(false)
      break
    case 'park':
      actions.parkSessionToArchive()
      break
    case 'new':
      actions.createNewTab()
      actions.setPaletteOpen(false)
      break
    case 'note':
      actions.quickNoteOnActive()
      break
    case 'cluster':
      actions.createClusterFromActive()
      break
    case 'sandbox':
      // §B.8.4 seam — the node carries partition:'sandbox'; the desktop
      // build wakes its live view inside the isolated 'temp:sandbox'
      // session (memory-only, logged-out). The prototype spawns an honest
      // local tab.
      actions.createNewTab({ title: 'Sandbox', url: 'https://sandbox.spatial/local', partition: 'sandbox' })
      actions.setPaletteOpen(false)
      break
    case 'mods':
      nav.onToggleExtensions?.()
      actions.setPaletteOpen(false)
      break
    case 'zap':
      // §B.9 — arm/disarm the Element Zapper on the active live view
      // (Alt+Shift+Click hides; the selector persists on the domain).
      actions.zapToggle()
      actions.setPaletteOpen(false)
      break
  }
}

/** Imperative omnibox keyboard seam: the focused header input forwards
 *  ArrowUp/Down/Enter to whatever result list is mounted below. */
type OmniboxNav = { moveSelection: (delta: number) => void; runSelected: () => void }

function OmniboxResults({
  entry,
  query,
  nav,
  registerNav,
}: {
  entry: OmniboxEntry
  query: string
  nav: DeckNav
  registerNav: (nav: OmniboxNav | null) => void
}) {
  const nodes = useGraphStore((s) => s.nodes)
  const notes = useGraphStore((s) => s.notes)
  const voiceMemos = useGraphStore((s) => s.voiceMemos)

  const navigateActiveNode = useGraphStore((s) => s.navigateActiveNode)
  const createNewTab = useGraphStore((s) => s.createNewTab)
  const openNodeInViewport = useGraphStore((s) => s.openNodeInViewport)
  const setPaletteOpen = useGraphStore((s) => s.setPaletteOpen)
  const toggleCanvas = useGraphStore((s) => s.toggleCanvas)
  const quickNoteOnActive = useGraphStore((s) => s.quickNoteOnActive)
  const parkSessionToArchive = useGraphStore((s) => s.parkSessionToArchive)
  const createClusterFromActive = useGraphStore((s) => s.createClusterFromActive)

  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  // §B.9 — the /zap toggle tracks the runtime's armed state (main pushes
  // spatial:zap:changed; without the runtime the command is a quiet no-op).
  const [zapArmed, setZapArmed] = useState(false)
  useEffect(() => spatialApi?.onZapChanged((payload) => setZapArmed(payload.armed === true)) ?? undefined, [])
  const zapToggle = useCallback(() => {
    void (zapArmed ? spatialApi?.zapDisarm() : spatialApi?.zapArm())
  }, [zapArmed])

  const actions = useMemo(
    () => ({ setPaletteOpen, toggleCanvas, quickNoteOnActive, parkSessionToArchive, createNewTab, createClusterFromActive, zapToggle }),
    [setPaletteOpen, toggleCanvas, quickNoteOnActive, parkSessionToArchive, createNewTab, createClusterFromActive, zapToggle],
  )

  const filteredCommands = useMemo(() => {
    if (entry.kind !== 'command') return []
    const filter = entry.filter
    if (filter === '') return SLASH_COMMANDS
    return SLASH_COMMANDS.filter(
      (command) => command.id.startsWith(filter) || command.label.toLowerCase().startsWith(filter),
    )
  }, [entry])

  const searchResults = useMemo<SearchResult[]>(
    () => (entry.kind === 'search' || entry.kind === 'bang' ? selectSearchResults(asSelectorState({ nodes, notes, voiceMemos }), query, 10) : []),
    [entry.kind, query, nodes, notes, voiceMemos],
  )

  const items = useMemo<OmniboxItem[]>(() => {
    if (entry.kind === 'command') return filteredCommands.map((command) => ({ type: 'command' as const, command }))
    if (entry.kind === 'url') {
      return [{ type: 'go' as const, url: entry.url, title: `Go to ${entry.title}`, detail: entry.url }]
    }
    if (entry.kind === 'bang') {
      return [
        { type: 'go' as const, url: entry.url, title: `${entry.bang.label} — ${entry.query || entry.bang.label}`, detail: entry.url },
        ...searchResults.map((result) => ({ type: 'result' as const, result })),
      ]
    }
    if (entry.kind === 'search') {
      const webSearch: OmniboxItem = {
        type: 'go',
        url: `https://www.google.com/search?q=${encodeURIComponent(entry.query)}`,
        title: `Search the web for “${entry.query}”`,
        detail: 'Google',
      }
      return [...searchResults.map((result) => ({ type: 'result' as const, result })), webSearch]
    }
    return []
  }, [entry, filteredCommands, searchResults])

  const safeIndex = Math.min(selectedIndex, Math.max(0, items.length - 1))

  function go(url: string, title: string) {
    const state = useGraphStore.getState()
    if (state.activeNodeUuid && state.nodes[state.activeNodeUuid]) {
      navigateActiveNode(url, title)
    } else {
      createNewTab({ url, title })
    }
    setPaletteOpen(false)
  }

  function runItem(item: OmniboxItem) {
    if (item.type === 'command') {
      runSlashCommand(item.command.id, nav, actions)
      return
    }
    if (item.type === 'go') {
      go(item.url, item.title)
      return
    }
    if (item.result.nodeId) openNodeInViewport(item.result.nodeId)
    setPaletteOpen(false)
  }

  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [safeIndex, items])

  /* The header input (mounted above, focus owner) forwards keys here.
     Re-registered every render so the closures always see fresh items. */
  useEffect(() => {
    registerNav({
      moveSelection: (delta: number) => {
        if (items.length === 0) return
        setSelectedIndex((current) => {
          const clamped = Math.min(current, items.length - 1)
          return (clamped + delta + items.length) % items.length
        })
      },
      runSelected: () => {
        const item = items[Math.min(selectedIndex, items.length - 1)]
        if (item) runItem(item)
      },
    })
    return () => registerNav(null)
  })

  const isCommands = entry.kind === 'command'

  return (
    <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
      {items.length > 0 && (
        <div className="px-2.5 pb-1 pt-1.5 text-[10px] text-[color:var(--ink-muted)]">
          {isCommands ? 'Commands' : entry.kind === 'url' || entry.kind === 'bang' ? 'Go' : 'Results'}
        </div>
      )}
      {items.map((item, index) => {
        const selected = index === safeIndex
        if (item.type === 'command') {
          const Icon = COMMAND_ICONS[item.command.id]
          return (
            <OmniboxRow
              key={`cmd-${item.command.id}`}
              selected={selected}
              onSelect={() => setSelectedIndex(index)}
              onRun={() => runItem(item)}
              icon={Icon}
              title={item.command.label}
              detail={item.command.description}
              chip={null}
            />
          )
        }
        if (item.type === 'go') {
          return (
            <OmniboxRow
              key={`go-${item.url}`}
              selected={selected}
              onSelect={() => setSelectedIndex(index)}
              onRun={() => runItem(item)}
              icon={entry.kind === 'bang' ? ExternalLink : Globe}
              title={item.title}
              detail={item.detail}
              chip={null}
            />
          )
        }
        const meta = RESULT_META[item.result.kind]
        return (
          <OmniboxRow
            key={`${item.result.kind}-${item.result.id}`}
            selected={selected}
            onSelect={() => setSelectedIndex(index)}
            onRun={() => runItem(item)}
            icon={meta.icon}
            title={item.result.title}
            detail={item.result.snippet}
            chip={meta.label}
          />
        )
      })}
      {items.length === 0 && (
        <div className="flex h-20 items-center justify-center px-4 text-center text-[12px] text-[color:var(--ink-muted)]">
          {isCommands
            ? `No command matches “${query}” — try /canvas or /park`
            : `No matches for “${query}” in tabs, notes or voice memos`}
        </div>
      )}
      {/* Enter on a bare search always resolves to a web search */}
      {entry.kind === 'search' && items.length > 0 && (
        <div className="flex items-center gap-2 px-2.5 pb-1 pt-1 text-[9.5px] text-[color:var(--ink-muted)]">
          <Kbd>↵</Kbd> runs the selection · last row searches the web
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Compact open-tab list (§B.4) — 1-level branch indent                 */
/* ------------------------------------------------------------------ */

function CompactOpenTabList({ onOpen }: { onOpen: (uuid: string) => void }) {
  const nodes = useGraphStore((s) => s.nodes)
  const activeNodeUuid = useGraphStore((s) => s.activeNodeUuid)

  const rows = useMemo(() => {
    const tabs = Object.values(nodes).filter((node) => node.nodeType !== 'ghost-echo')
    return [...tabs].sort((a, b) => {
      if (a.uuid === activeNodeUuid) return -1
      if (b.uuid === activeNodeUuid) return 1
      return b.lastVisitedAt - a.lastVisitedAt
    })
  }, [nodes, activeNodeUuid])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
      {rows.map((node) => {
        const branched = node.parentUuid !== null
        const isActive = node.uuid === activeNodeUuid
        return (
          <button
            key={node.uuid}
            type="button"
            onClick={() => onOpen(node.uuid)}
            title={`${node.title} — ${node.url}`}
            className={cn(
              'group flex h-9 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left transition-colors hover:bg-[color:var(--glass-soft)]',
              branched && 'pl-7',
            )}
          >
            {branched && <span aria-hidden className="-ml-3 shrink-0 text-[10px] text-[color:var(--ink-muted)]">↳</span>}
            <span
              className={cn(
                'h-2 w-2 shrink-0 rounded-full',
                isActive
                  ? 'bg-[color:var(--accent)]'
                  : node.ramState === 'live'
                    ? 'bg-[color:var(--ink-secondary)]'
                    : 'border-[1.5px] border-[color:var(--ink-muted)]',
              )}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-[color:var(--ink-primary)]">{node.title}</span>
            <span className="shrink-0 text-[10px] text-[color:var(--ink-muted)]">{node.domain}</span>
            {node.isPinned && <Heart size={10} strokeWidth={1.75} className="shrink-0 text-[color:var(--ink-secondary)]" aria-hidden />}
          </button>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Horizon 1 — Active Working Session strip (§B.2)                      */
/* ------------------------------------------------------------------ */

function HorizonActiveSession({ onOpen }: { onOpen: (uuid: string) => void }) {
  const nodes = useGraphStore((s) => s.nodes)
  const activeNodeUuid = useGraphStore((s) => s.activeNodeUuid)
  const recordingNodeId = useGraphStore((s) => s.recordingNodeId)
  const parkNodeToArchive = useGraphStore((s) => s.parkNodeToArchive)
  const parkSessionToArchive = useGraphStore((s) => s.parkSessionToArchive)

  const liveNodes = useMemo(
    () =>
      Object.values(nodes)
        .filter((node) => node.ramState === 'live' && node.nodeType !== 'ghost-echo')
        .sort((a, b) => {
          if (a.uuid === activeNodeUuid) return -1
          if (b.uuid === activeNodeUuid) return 1
          return b.lastVisitedAt - a.lastVisitedAt
        }),
    [nodes, activeNodeUuid],
  )

  return (
    <section className="shrink-0 border-b border-hairline px-3 pb-2.5 pt-2">
      <div className="flex h-7 items-center gap-2">
        <span className="text-[10px] font-medium text-[color:var(--ink-muted)]">Active session · {liveNodes.length}</span>
        <button
          type="button"
          onClick={() => parkSessionToArchive()}
          disabled={liveNodes.length === 0}
          title="Park session — every non-immune live tab to the 0 MB archive"
          className="ml-auto flex items-center gap-1 rounded-full border border-hairline px-2 py-0.5 text-[10px] text-[color:var(--ink-secondary)] transition-colors hover:border-[color:var(--border-hover)] hover:text-[color:var(--ink-primary)] disabled:pointer-events-none disabled:opacity-40"
        >
          <Moon size={9} strokeWidth={1.75} aria-hidden />
          Park session
        </button>
      </div>
      {liveNodes.length === 0 ? (
        <p className="pb-1 text-[11px] text-[color:var(--ink-muted)]">Everything is asleep — 0 MB live.</p>
      ) : (
        <div className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {liveNodes.map((node) => {
            const isActive = node.uuid === activeNodeUuid
            const isRecording = node.uuid === recordingNodeId
            return (
              <div
                key={node.uuid}
                className={cn(
                  'flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-2 transition-colors',
                  isActive
                    ? 'border-[color:var(--border-active)] bg-[color:var(--glass-soft)]'
                    : 'border-hairline hover:border-[color:var(--border-hover)]',
                )}
              >
                <button
                  type="button"
                  onClick={() => onOpen(node.uuid)}
                  title={`${node.title} — ${node.domain}`}
                  className="flex min-w-0 max-w-[168px] items-center gap-1.5 text-left"
                >
                  <FaviconMark domain={node.domain} size={16} />
                  <span className="min-w-0 truncate text-[11.5px] text-[color:var(--ink-primary)]">{node.title}</span>
                </button>
                {node.isAudible && (
                  <motion.span
                    className="shrink-0 text-[color:var(--ink-secondary)]"
                    animate={{ opacity: [1, 0.5, 1] }}
                    transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
                    title="Playing audio — immune to auto-hibernation"
                  >
                    <AudioLines size={11} />
                  </motion.span>
                )}
                {isRecording && (
                  <motion.span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--accent)]"
                    animate={{ opacity: [1, 0.35, 1] }}
                    transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
                    title="Recording voice memo on this tab"
                  />
                )}
                <button
                  type="button"
                  onClick={() => parkNodeToArchive(node.uuid)}
                  disabled={isRecording}
                  title={`Park “${node.title}” to the 0 MB archive`}
                  aria-label={`Park ${node.title}`}
                  className="flex size-5 shrink-0 items-center justify-center rounded-full text-[color:var(--ink-muted)] transition-colors hover:bg-[color:var(--glass-soft)] hover:text-[color:var(--ink-primary)] disabled:pointer-events-none disabled:opacity-35"
                >
                  <Moon size={10} strokeWidth={1.75} aria-hidden />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Horizon 2 — Sleeping Visual Archive (§B.2)                           */
/*   chips · 16:10 bento scrub grid · in-place stack scrubbing ·        */
/*   1-hop lineage hairlines · provenance · click wakes + closes        */
/* ------------------------------------------------------------------ */

type ArchiveFilter = { kind: 'all' } | { kind: 'region'; regionId: string } | { kind: 'ghosts' } | { kind: 'notes' }

function ArchiveScrubCard({
  node,
  relatedUuids,
  isHovered,
  onHover,
  onLeave,
  onOpen,
}: {
  node: SpatialTabNodeRecord
  relatedUuids: Set<string>
  isHovered: boolean
  onHover: () => void
  onLeave: () => void
  onOpen: (uuid: string) => void
}) {
  const allNodes = useGraphStore((s) => s.nodes)
  const children = useMemo(
    () =>
      selectChildren(asSelectorState({ nodes: allNodes }), node.uuid).filter(
        (child) => child.nodeType !== 'ghost-echo',
      ),
    [allNodes, node.uuid],
  )
  const [scrubIndex, setScrubIndex] = useState(0)
  const scrubbing = children.length > 0 && scrubIndex > 0
  const shown = scrubbing ? children[Math.min(scrubIndex, children.length) - 1] ?? node : node

  const parent = node.parentUuid ? allNodes[node.parentUuid] : null

  const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (children.length === 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    setScrubIndex(1 + Math.floor(ratio * children.length))
  }

  const related = relatedUuids.has(node.uuid)

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => onOpen(shown.uuid)}
        onPointerEnter={onHover}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => {
          setScrubIndex(0)
          onLeave()
        }}
        title={scrubbing ? shown.title : `${node.title} — ${node.domain}`}
        className={cn(
          'block w-full overflow-hidden rounded-[12px] border text-left transition-colors',
          isHovered || related
            ? 'border-[color:var(--border-active)]'
            : 'border-hairline hover:border-[color:var(--border-hover)]',
        )}
        style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-card)' }}
      >
        <div className="relative aspect-[16/10] w-full overflow-hidden bg-[color:var(--glass-soft)]">
          <PreviewArt spec={previewSpecForNode(shown)} className="absolute inset-0" />
          {children.length > 0 && (
            <span
              className="absolute right-1.5 top-1.5 rounded-full border border-hairline px-1.5 py-0.5 text-[9px] text-[color:var(--ink-secondary)]"
              style={{ background: 'var(--bg-elevated)' }}
            >
              +{children.length}
            </span>
          )}
        </div>
        <div className="px-2 py-1.5">
          <p className="truncate text-[11.5px] text-[color:var(--ink-primary)]">{shown.title}</p>
          <p className="truncate text-[10px] text-[color:var(--ink-muted)]">
            {node.domain} · {formatRamMb(node.ramMb)}
          </p>
          {parent && (
            <p className="truncate pt-0.5 text-[10px] text-[color:var(--ink-muted)]" title={`via “${parent.title}”`}>
              <span aria-hidden>↳ </span>via “{parent.title}”
            </p>
          )}
          {node.isPinned && (
            <p className="flex items-center gap-1 pt-0.5 text-[10px] text-[color:var(--ink-muted)]">
              <Heart size={9} strokeWidth={1.75} aria-hidden /> Anchored in its Flow
            </p>
          )}
        </div>
        {/* segmented scrub bar — video-timeline scrubbing, in place (§B.2) */}
        {children.length > 0 && (
          <div className="flex h-1.5 gap-0.5 px-2 pb-1.5" aria-hidden>
            {children.map((child, index) => (
              <span
                key={child.uuid}
                className={cn(
                  'h-full flex-1 rounded-full',
                  scrubIndex > index ? 'bg-[color:var(--ink-secondary)]' : 'bg-[color:var(--glass-soft)] border border-hairline',
                )}
              />
            ))}
          </div>
        )}
      </button>
      {/* 1-hop lineage hairline — a 1px connector toward the hovered neighbour */}
      {related && !isHovered && (
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 h-px w-2 -translate-y-1/2 bg-[color:var(--border-active)]"
          style={{ left: -8 }}
        />
      )}
    </div>
  )
}

function HorizonSleepingArchive({ onOpen }: { onOpen: (uuid: string) => void }) {
  const nodes = useGraphStore((s) => s.nodes)
  const edges = useGraphStore((s) => s.edges)
  const notes = useGraphStore((s) => s.notes)
  const regions = useGraphStore((s) => s.regions)

  const [filter, setFilter] = useState<ArchiveFilter>({ kind: 'all' })
  const [hoveredUuid, setHoveredUuid] = useState<string | null>(null)

  const hibernated = useMemo(
    () => Object.values(nodes).filter((node) => node.ramState === 'hibernated'),
    [nodes],
  )
  const ghostCount = useMemo(() => hibernated.filter((node) => node.nodeType === 'ghost-echo').length, [hibernated])
  const notedUuids = useMemo(() => {
    const notedHashes = new Set(Object.values(notes).map((note) => note.urlHash))
    return new Set(hibernated.filter((node) => notedHashes.has(node.urlHash)).map((node) => node.uuid))
  }, [hibernated, notes])

  const regionChips = useMemo(() => {
    return Object.values(regions)
      .map((region) => ({
        region,
        count: hibernated.filter((node) => node.regionId === region.id && node.nodeType !== 'ghost-echo').length,
      }))
      .filter((entry) => entry.count > 0)
      .sort((a, b) => b.count - a.count)
  }, [regions, hibernated])

  const cards = useMemo(() => {
    const pool = hibernated.filter((node) => {
      if (filter.kind === 'all') return true
      if (filter.kind === 'ghosts') return node.nodeType === 'ghost-echo'
      if (filter.kind === 'notes') return notedUuids.has(node.uuid)
      return node.regionId === filter.regionId && node.nodeType !== 'ghost-echo'
    })
    return [...pool].sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
  }, [hibernated, filter, notedUuids])

  /** §B.2 1-hop trail connectors — nodes sharing a spawn/visit edge with the hovered card. */
  const relatedUuids = useMemo(() => {
    if (!hoveredUuid) return new Set<string>()
    const related = new Set<string>()
    for (const edgeRecord of Object.values(edges)) {
      if (edgeRecord.kind !== 'spawn' && edgeRecord.kind !== 'visit') continue
      if (edgeRecord.source === hoveredUuid) related.add(edgeRecord.target)
      else if (edgeRecord.target === hoveredUuid) related.add(edgeRecord.source)
    }
    related.delete(hoveredUuid)
    return related
  }, [edges, hoveredUuid])

  const chipClass = (active: boolean) =>
    cn(
      'flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-[10.5px] transition-colors',
      active
        ? 'border-[color:var(--border-active)] bg-[color:var(--glass-soft)] text-[color:var(--ink-primary)]'
        : 'border-hairline text-[color:var(--ink-secondary)] hover:border-[color:var(--border-hover)] hover:text-[color:var(--ink-primary)]',
    )

  return (
    <section className="flex min-h-0 flex-1 flex-col px-3 pb-2 pt-2">
      {/* filter bar — All · per-Flow chips · Ghost Echoes · Notes */}
      <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" title="Sleeping Visual Archive — 0 MB cached previews">
        <button type="button" onClick={() => setFilter({ kind: 'all' })} className={chipClass(filter.kind === 'all')}>
          All · {hibernated.length}
        </button>
        {regionChips.map(({ region, count }) => (
          <button
            key={region.id}
            type="button"
            onClick={() => setFilter({ kind: 'region', regionId: region.id })}
            className={chipClass(filter.kind === 'region' && filter.regionId === region.id)}
            title={`${region.name} — ${count} asleep`}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: region.color }} aria-hidden />
            {region.name} · {count}
          </button>
        ))}
        {ghostCount > 0 && (
          <button type="button" onClick={() => setFilter({ kind: 'ghosts' })} className={chipClass(filter.kind === 'ghosts')}>
            Ghost Echoes · {ghostCount}
          </button>
        )}
        {notedUuids.size > 0 && (
          <button type="button" onClick={() => setFilter({ kind: 'notes' })} className={chipClass(filter.kind === 'notes')}>
            Notes · {notedUuids.size}
          </button>
        )}
      </div>

      {/* 3–4 column 16:10 bento scrub grid (max-h 340px, smooth scroll) */}
      <div className="grid max-h-[340px] min-h-0 flex-1 grid-cols-3 content-start gap-2 overflow-y-auto overscroll-contain pr-1 [scrollbar-color:var(--border-hover)_transparent] [scrollbar-width:thin] md:grid-cols-4">
        {cards.map((node) => (
          <ArchiveScrubCard
            key={node.uuid}
            node={node}
            relatedUuids={relatedUuids}
            isHovered={hoveredUuid === node.uuid}
            onHover={() => setHoveredUuid(node.uuid)}
            onLeave={() => setHoveredUuid((current) => (current === node.uuid ? null : current))}
            onOpen={onOpen}
          />
        ))}
      </div>
      {cards.length === 0 && (
        <p className="py-6 text-center text-[11.5px] text-[color:var(--ink-muted)]">Nothing asleep under this filter.</p>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Footer Utility Dock (§B.2, 40px)                                     */
/* ------------------------------------------------------------------ */

function FlowsPopover({
  notches,
  onFocusFlow,
  onClose,
}: {
  notches: FlowNotch[]
  onFocusFlow: (regionId: string) => void
  onClose: () => void
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={SPRING}
      className="absolute bottom-11 right-2 z-50 w-[320px] overflow-hidden rounded-[14px] border border-hairline"
      style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-pop)' }}
      onPointerLeave={onClose}
    >
      <div className="border-b border-hairline px-3 py-2 text-[10px] text-[color:var(--ink-muted)]">
        Flows — non-exclusive tab trees in one session
      </div>
      <div className="max-h-[240px] overflow-y-auto p-1.5">
        {notches.length === 0 && <p className="px-2 py-3 text-[11.5px] text-[color:var(--ink-muted)]">No active Flows yet.</p>}
        {notches.map((notch) => (
          <button
            key={notch.regionId}
            type="button"
            onClick={() => onFocusFlow(notch.regionId)}
            title={`Open “${notch.name}” on the spatial canvas`}
            className="flex h-9 w-full items-center gap-2 rounded-[10px] px-2.5 text-left transition-colors hover:bg-[color:var(--glass-soft)]"
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: notch.color }} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--ink-primary)]">{notch.name}</span>
            {notch.hasPinned && <Heart size={10} strokeWidth={1.75} className="shrink-0 text-[color:var(--ink-muted)]" aria-hidden />}
            <span className="shrink-0 text-[10px] text-[color:var(--ink-muted)]">
              · {notch.liveCount}/{notch.nodeCount}
            </span>
          </button>
        ))}
      </div>
    </motion.div>
  )
}

function FooterDock({
  nav,
  notches,
  onFocusFlow,
}: {
  nav: DeckNav
  notches: FlowNotch[]
  onFocusFlow: (regionId: string) => void
}) {
  const [flowsOpen, setFlowsOpen] = useState(false)
  const createNewTab = useGraphStore((s) => s.createNewTab)
  const parkSessionToArchive = useGraphStore((s) => s.parkSessionToArchive)
  const quickNoteOnActive = useGraphStore((s) => s.quickNoteOnActive)
  const toggleGlance = useGraphStore((s) => s.toggleGlance)
  const toggleCanvas = useGraphStore((s) => s.toggleCanvas)
  const setPaletteOpen = useGraphStore((s) => s.setPaletteOpen)

  const openSandbox = () => {
    // §B.8.4 seam — in the desktop build this spawns into the isolated
    // 'temp:sandbox' session partition; the shell preview spawns a tab
    // honestly labelled Sandbox.
    createNewTab({ title: 'Sandbox', url: 'https://sandbox.spatial/local' })
    setPaletteOpen(false)
  }

  return (
    <footer className="relative flex h-10 shrink-0 items-center gap-1 border-t border-hairline px-3">
      <div className="flex items-center gap-0.5">
        <QuietButton icon={Plus} label="New tab (Ctrl+T)" onClick={() => { createNewTab(); setPaletteOpen(false) }} />
        <QuietButton icon={ShieldCheck} label="Sandbox tab (/sandbox — isolated partition in the desktop build)" onClick={openSandbox} />
        <QuietButton icon={Moon} label="Sleep session — park every non-immune live tab (0 MB)" onClick={() => parkSessionToArchive()} />
      </div>
      <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-hairline" />
      <div className="flex items-center gap-0.5">
        <QuietButton icon={Boxes} label="Flows" onClick={() => setFlowsOpen((open) => !open)} active={flowsOpen} />
        <QuietButton icon={StickyNote} label="Notes & memos — quick note on the active tab (Alt+N)" onClick={() => quickNoteOnActive()} />
        <QuietButton icon={History} label="Trail history — 1–2 hop neighbourhood glance (⌘/Ctrl+Shift+G)" onClick={() => { toggleGlance(); setPaletteOpen(false) }} />
        <QuietButton
          icon={Download}
          label="Downloads arrive with the desktop shell (Ctrl+J — Phase 3 plumbing)"
          onClick={() => {}}
          disabled
        />
        {nav.onToggleSplit && (
          <QuietButton icon={Columns2} label="Split view — read two tabs side by side" onClick={() => { nav.onToggleSplit?.(); setPaletteOpen(false) }} />
        )}
        {nav.onToggleExtensions && (
          <QuietButton icon={Puzzle} label="Studio Plugins & Mods (/mods)" onClick={() => { nav.onToggleExtensions?.(); setPaletteOpen(false) }} />
        )}
      </div>
      <button
        type="button"
        onClick={() => { toggleCanvas(); setPaletteOpen(false) }}
        title="Open the full spatial canvas (⌘/Ctrl+Space · Alt+Space)"
        className="ml-auto flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-hairline bg-[color:var(--glass-soft)] px-3 text-[11px] font-medium text-[color:var(--ink-primary)] transition-colors hover:border-[color:var(--border-hover)]"
      >
        <Maximize2 size={11} strokeWidth={1.75} aria-hidden />
        Open Spatial Canvas <Kbd>⌘space</Kbd>
      </button>
      <AnimatePresence>
        {flowsOpen && (
          <FlowsPopover
            notches={notches}
            onFocusFlow={(regionId) => {
              setFlowsOpen(false)
              onFocusFlow(regionId)
            }}
            onClose={() => setFlowsOpen(false)}
          />
        )}
      </AnimatePresence>
    </footer>
  )
}

/* ------------------------------------------------------------------ */
/* The Stage 1 deck shell (compact ⇄ expanded, one layoutId)            */
/* ------------------------------------------------------------------ */

function IslandDeck({
  nav,
  compact,
  onOpenTab,
  onFocusFlow,
  notches,
  dragHandlers,
}: {
  nav: DeckNav
  compact: boolean
  onOpenTab: (uuid: string) => void
  onFocusFlow: (regionId: string) => void
  notches: FlowNotch[]
  dragHandlers: ShellDragHandlers
}) {
  const activeNode = useGraphStore((s) => (s.activeNodeUuid ? (s.nodes[s.activeNodeUuid] ?? null) : null))
  const hibernatedCount = useGraphStore((s) => selectHibernatedCount(asSelectorState({ nodes: s.nodes })))
  const setPaletteOpen = useGraphStore((s) => s.setPaletteOpen)
  const pinNode = useGraphStore((s) => s.pinNode)

  const [query, setQuery] = useState('')
  const entry = useMemo<OmniboxEntry>(() => resolveOmniboxEntry(query), [query])

  /* Keyboard seam: the focused omnibox input forwards ↑/↓/Enter into the
     mounted result list (items + selection live in OmniboxResults). */
  const omniboxNavRef = useRef<OmniboxNav | null>(null)
  const registerOmniboxNav = (nav: OmniboxNav | null) => {
    omniboxNavRef.current = nav
  }

  const toggleCanvasAndClose = () => {
    useGraphStore.getState().toggleCanvas()
    setPaletteOpen(false)
  }

  /** §B.3 pinch-out — trackpad pinch sends ctrl+wheel; zooming out opens Stage 2. */
  const pinchAccumulator = useRef(0)
  const handleWheel = (event: React.WheelEvent) => {
    if (!event.ctrlKey) return
    pinchAccumulator.current += event.deltaY
    if (pinchAccumulator.current > 90) {
      pinchAccumulator.current = 0
      toggleCanvasAndClose()
    }
  }

  return (
    <motion.div
      layoutId="floating-island"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, width: compact ? 480 : 760 }}
      exit={{ opacity: 0 }}
      transition={SPRING}
      onWheel={handleWheel}
      className="pointer-events-auto flex max-h-[calc(100vh_-_96px)] max-w-[calc(100vw_-_24px)] flex-col overflow-hidden border border-hairline rounded-[20px]"
      style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-pop)' }}
      {...dragHandlers}
    >
      {/* ---- header row (48px): lock · omnibox · nav · split · pin · collapse ---- */}
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-hairline px-3">
        <span
          title="https — pages are simulated in this preview"
          className="flex size-6 shrink-0 items-center justify-center text-[color:var(--ink-muted)]"
        >
          <Lock size={12} strokeWidth={1.75} aria-hidden />
        </span>
        <input
          /* ⌘/Ctrl+L lands here with the input focused (§B.1) */
          autoFocus
          value={query}
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              setPaletteOpen(false)
            } else if (event.key === 'ArrowDown') {
              event.preventDefault()
              omniboxNavRef.current?.moveSelection(1)
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              omniboxNavRef.current?.moveSelection(-1)
            } else if (event.key === 'Enter') {
              event.preventDefault()
              omniboxNavRef.current?.runSelected()
            }
          }}
          placeholder="Search tabs, paste a URL, or type / or !g"
          className="h-8 min-w-0 flex-1 rounded-full border border-hairline bg-transparent px-3 text-[12.5px] text-[color:var(--ink-primary)] outline-none placeholder:text-[color:var(--ink-muted)] focus:border-[color:var(--border-hover)]"
        />
        <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-hairline" />
        <QuietButton icon={ArrowLeft} label="Back — active tab history" onClick={nav.onBack} disabled={!nav.canBack} />
        <QuietButton icon={ArrowRight} label="Forward — active tab history" onClick={nav.onForward} disabled={!nav.canForward} />
        <QuietButton icon={RotateCw} label="Reload page" onClick={nav.onReload} />
        {nav.onToggleExtensions && (
          /* §B.2 Live-Mod trigger — the §B.0 /mods quick-toggle seam (the
             zero-extension Live Mods engine lands with the desktop build) */
          <QuietButton icon={Puzzle} label="Live Mods & Studio Plugins (/mods)" onClick={nav.onToggleExtensions} />
        )}
        {nav.onToggleSplit && (
          <QuietButton icon={Columns2} label="Split view — read two tabs side by side" onClick={nav.onToggleSplit} />
        )}
        <QuietButton
          icon={Heart}
          label={activeNode?.isPinned ? 'Unpin this anchor' : 'Pin as a permanent anchor (pinning replaces bookmarks)'}
          onClick={() => activeNode && pinNode(activeNode.uuid, !activeNode.isPinned)}
          active={activeNode?.isPinned ?? false}
          disabled={!activeNode}
        />
        <QuietButton icon={X} label="Collapse the island (Esc)" onClick={() => setPaletteOpen(false)} />
      </div>

      {/* ---- body: compact list · omnibox results · dual horizons ---- */}
      {query.trim() !== '' ? (
        <OmniboxResults entry={entry} query={query} nav={nav} registerNav={registerOmniboxNav} />
      ) : compact ? (
        <CompactOpenTabList onOpen={onOpenTab} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <HorizonActiveSession onOpen={onOpenTab} />
          {/* §B.4 — archive headers stay hidden when nothing is hibernated */}
          {hibernatedCount > 0 && <HorizonSleepingArchive onOpen={onOpenTab} />}
        </div>
      )}

      {/* ---- footer ---- */}
      {query.trim() === '' && (
        compact ? (
          /* §B.4 compact utility row */
          <CompactUtilityRow nav={nav} />
        ) : (
          <FooterDock nav={nav} notches={notches} onFocusFlow={onFocusFlow} />
        )
      )}
    </motion.div>
  )
}

/** §B.4 compact-mode utility row (Blanc-minimal). */
function CompactUtilityRow({ nav }: { nav: DeckNav }) {
  const createNewTab = useGraphStore((s) => s.createNewTab)
  const parkSessionToArchive = useGraphStore((s) => s.parkSessionToArchive)
  const toggleCanvas = useGraphStore((s) => s.toggleCanvas)
  const setPaletteOpen = useGraphStore((s) => s.setPaletteOpen)

  return (
    <div className="flex h-10 shrink-0 items-center gap-0.5 border-t border-hairline px-3">
      <QuietButton icon={Plus} label="New tab (Ctrl+T)" onClick={() => { createNewTab(); setPaletteOpen(false) }} />
      <QuietButton
        icon={ShieldCheck}
        label="Sandbox tab (/sandbox — isolated partition in the desktop build)"
        onClick={() => { createNewTab({ title: 'Sandbox', url: 'https://sandbox.spatial/local' }); setPaletteOpen(false) }}
      />
      <QuietButton icon={Moon} label="Sleep session — park every non-immune live tab (0 MB)" onClick={() => parkSessionToArchive()} />
      <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-hairline" />
      {nav.onToggleExtensions && (
        <QuietButton icon={Puzzle} label="Studio Plugins & Mods (/mods)" onClick={() => { nav.onToggleExtensions?.(); setPaletteOpen(false) }} />
      )}
      <button
        type="button"
        onClick={() => { toggleCanvas(); setPaletteOpen(false) }}
        title="Open the full spatial canvas (⌘/Ctrl+Space · Alt+Space)"
        className="ml-auto flex h-7 items-center gap-1.5 rounded-full border border-hairline bg-[color:var(--glass-soft)] px-2.5 text-[11px] font-medium text-[color:var(--ink-primary)] transition-colors hover:border-[color:var(--border-hover)]"
      >
        <Maximize2 size={11} strokeWidth={1.75} aria-hidden />
        Canvas <Kbd>⌘space</Kbd>
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* §B.5 Satellite Flow Notches (32px pills flanking the island)         */
/* ------------------------------------------------------------------ */

function NotchPopover({
  notch,
  rows,
  onWakeNode,
  onFocusFlow,
}: {
  notch: FlowNotch
  rows: FlowTreeRow[]
  onWakeNode: (uuid: string) => void
  onFocusFlow: (regionId: string) => void
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={SPRING}
      className="pointer-events-auto absolute left-1/2 top-full z-40 w-[320px] -translate-x-1/2 pt-2"
    >
      <div
        className="overflow-hidden rounded-[14px] border border-hairline"
        style={{ background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-pop)' }}
      >
        <button
          type="button"
          onClick={() => onFocusFlow(notch.regionId)}
          title={`Open “${notch.name}” on the spatial canvas (Mode B pans to its bounding box)`}
          className="flex h-9 w-full items-center gap-2 border-b border-hairline px-3 text-left transition-colors hover:bg-[color:var(--glass-soft)]"
        >
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: notch.color }} aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[color:var(--ink-primary)]">{notch.name}</span>
          {notch.hasPinned && <Heart size={10} strokeWidth={1.75} className="shrink-0 text-[color:var(--ink-muted)]" aria-hidden />}
          <span className="shrink-0 text-[10px] text-[color:var(--ink-muted)]">· {notch.nodeCount}</span>
        </button>
        <div className="max-h-[280px] overflow-y-auto p-1.5">
          {rows.map(({ node, depth }) => (
            <button
              key={node.uuid}
              type="button"
              onClick={() => onWakeNode(node.uuid)}
              title={`${node.title} — ${node.ramState === 'live' ? 'Live' : `Sleeping · ${formatRamMb(node.ramMb)}`}`}
              className={cn(
                'flex h-9 w-full items-center gap-2 rounded-[10px] px-2.5 text-left transition-colors hover:bg-[color:var(--glass-soft)]',
                depth === 1 && 'pl-6',
              )}
            >
              {depth === 1 && <span aria-hidden className="-ml-2.5 shrink-0 text-[10px] text-[color:var(--ink-muted)]">↳</span>}
              <FaviconMark domain={node.domain} size={16} />
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-[color:var(--ink-primary)]">{node.title}</span>
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  node.ramState === 'live' ? 'bg-[color:var(--ink-secondary)]' : 'border-[1.5px] border-[color:var(--ink-muted)]',
                )}
                aria-hidden
              />
            </button>
          ))}
          {rows.length === 0 && <p className="px-2 py-3 text-[11.5px] text-[color:var(--ink-muted)]">This Flow is empty.</p>}
        </div>
      </div>
    </motion.div>
  )
}

function FlowNotchPill({
  notch,
  onWakeNode,
  onFocusFlow,
}: {
  notch: FlowNotch
  onWakeNode: (uuid: string) => void
  onFocusFlow: (regionId: string) => void
}) {
  const nodes = useGraphStore((s) => s.nodes)
  const rows = useMemo(
    () => selectFlowTreeRows(asSelectorState({ nodes }), notch.regionId),
    [nodes, notch.regionId],
  )
  const [hovered, setHovered] = useState(false)
  return (
    <motion.div
      className="pointer-events-auto relative"
      onHoverStart={() => setHovered(true)}
      onHoverEnd={() => setHovered(false)}
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={SPRING}
    >
      <div
        className="flex h-8 items-center gap-1.5 rounded-full border border-hairline bg-surface-glass px-2.5 backdrop-blur-xl"
        style={{ boxShadow: 'var(--shadow-card)' }}
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: notch.color }} aria-hidden />
        <button
          type="button"
          onClick={() => onFocusFlow(notch.regionId)}
          title={`${notch.name} · ${notch.nodeCount} — click to pan Mode B to this Flow`}
          className="max-w-[120px] truncate text-[11px] text-[color:var(--ink-secondary)] transition-colors hover:text-[color:var(--ink-primary)]"
        >
          {notch.name}
        </button>
        <span className="shrink-0 text-[10px] tabular-nums text-[color:var(--ink-muted)]">· {notch.nodeCount}</span>
      </div>
      <AnimatePresence>
        {hovered && (
          <NotchPopover notch={notch} rows={rows} onWakeNode={onWakeNode} onFocusFlow={onFocusFlow} />
        )}
      </AnimatePresence>
    </motion.div>
  )
}

/* ------------------------------------------------------------------ */
/* FloatingIslandPill — Stage 0 resting pill + continuum orchestration  */
/* ------------------------------------------------------------------ */

export function FloatingIslandPill({
  className,
  canBack = false,
  canForward = false,
  onBack,
  onForward,
  onReload,
  onToggleSplit,
  onToggleExtensions,
  shieldBlockedCount,
}: FloatingIslandPillProps) {
  /* --- store state (narrow selectors; records/maps keep identity until changed) --- */
  const activeNode = useGraphStore((s) => (s.activeNodeUuid ? (s.nodes[s.activeNodeUuid] ?? null) : null))
  const nodes = useGraphStore((s) => s.nodes)
  const edges = useGraphStore((s) => s.edges)
  const regions = useGraphStore((s) => s.regions)
  const paletteOpen = useGraphStore((s) => s.paletteOpen)
  const viewMode = useGraphStore((s) => s.viewMode)
  const recordingNodeId = useGraphStore((s) => s.recordingNodeId)

  /* --- store actions (stable references) --- */
  const setPaletteOpen = useGraphStore((s) => s.setPaletteOpen)
  const spawnChildNode = useGraphStore((s) => s.spawnChildNode)
  const activateNode = useGraphStore((s) => s.activateNode)
  const openNodeInViewport = useGraphStore((s) => s.openNodeInViewport)
  const createNewTab = useGraphStore((s) => s.createNewTab)
  const pinNode = useGraphStore((s) => s.pinNode)
  const closeNode = useGraphStore((s) => s.closeNode)
  const navigateActiveNode = useGraphStore((s) => s.navigateActiveNode)
  const focusRegionOnCanvas = useGraphStore((s) => s.focusRegionOnCanvas)
  const sweepIdleHibernation = useGraphStore((s) => s.sweepIdleHibernation)

  const isRecording = recordingNodeId !== null && activeNode?.uuid === recordingNodeId

  /* --- §B.4 elastic disclosure — compact while the world is small and nothing sleeps --- */
  const totalNodes = useMemo(
    () => selectTotalNodeCount(asSelectorState({ nodes })),
    [nodes],
  )
  const hibernatedCount = useMemo(
    () => selectHibernatedCount(asSelectorState({ nodes })),
    [nodes],
  )
  const compact = totalNodes <= 8 && hibernatedCount === 0

  /* --- §B.1 dots — recompute when the graph actually changes (memoized, not per-render) --- */
  const dots = useMemo(
    () => (activeNode ? selectPillNeighbours(asSelectorState({ nodes, edges }), activeNode.uuid) : []),
    [activeNode, nodes, edges],
  )

  /* --- §B.5 notches — active Flows other than the one hosting the active tab --- */
  const notches = useMemo(
    () => selectFlowNotches(asSelectorState({ nodes, regions, activeNodeUuid: activeNode?.uuid ?? null })),
    [nodes, regions, activeNode],
  )

  /* --- nav seam: App owns the per-node history; fall back to store-level reload --- */
  const nav: DeckNav = useMemo(
    () => ({
      canBack,
      canForward,
      onBack: onBack ?? (() => {}),
      onForward: onForward ?? (() => {}),
      onReload: onReload ?? (() => {
        if (!activeNode) return
        navigateActiveNode(activeNode.url, activeNode.title, activeNode.searchQuery ?? undefined)
      }),
      onToggleSplit: onToggleSplit ?? null,
      onToggleExtensions: onToggleExtensions ?? null,
    }),
    [canBack, canForward, onBack, onForward, onReload, onToggleSplit, onToggleExtensions, activeNode, navigateActiveNode],
  )

  /* --- §B.6 guardrail sweep — the idle clock ticks while the shell lives --- */
  useEffect(() => {
    const tick = () => sweepIdleHibernation()
    const timer = window.setInterval(tick, IDLE_SWEEP_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [sweepIdleHibernation])

  /* --- Stage 2: entering Mode B collapses the deck — the pill stays anchored --- */
  useEffect(() => {
    if (viewMode === 'canvas' && paletteOpen) setPaletteOpen(false)
  }, [viewMode, paletteOpen, setPaletteOpen])

  /* --- §6 drag-to-anchor drop zone (shared by both shells) --- */
  const dragDepth = useRef(0)
  const [isDragOver, setIsDragOver] = useState(false)
  const [spawnPulse, setSpawnPulse] = useState(0)

  const acceptsDrag = (event: ReactDragEvent): boolean => {
    const types = event.dataTransfer.types
    return types.includes(SPATIAL_DRAG_MIME) || types.includes('text/uri-list') || types.includes('text/plain')
  }

  const handleDragEnter = (event: ReactDragEvent) => {
    if (!acceptsDrag(event) || !activeNode) return
    event.preventDefault()
    dragDepth.current += 1
    setIsDragOver(true)
  }

  const handleDragOver = (event: ReactDragEvent) => {
    // Always allow the drop (and always block the browser's default
    // "navigate to dropped URL") — the highlight itself is gated below.
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    if (acceptsDrag(event) && activeNode) setIsDragOver(true)
  }

  const handleDragLeave = (_event: ReactDragEvent) => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setIsDragOver(false)
  }

  const handleDrop = (event: ReactDragEvent) => {
    event.preventDefault()
    dragDepth.current = 0
    setIsDragOver(false)
    if (!activeNode) return
    const payload = parseSpatialDrop(event.dataTransfer)
    if (!payload) return
    spawnChildNode(activeNode.uuid, payload)
    setSpawnPulse((count) => count + 1)
  }

  const dragHandlers: ShellDragHandlers = {
    onDragEnter: handleDragEnter,
    onDragOver: handleDragOver,
    onDragLeave: handleDragLeave,
    onDrop: handleDrop,
  }

  const openTabFromDeck = (uuid: string) => {
    openNodeInViewport(uuid)
    setPaletteOpen(false)
  }

  const wakeFromNotch = (uuid: string) => {
    // §B.5 — wake into the current session WITHOUT hiding other Flows.
    openNodeInViewport(uuid)
  }

  /* ------------------------------------------------------------------ */

  return (
    <div className={cn('pointer-events-none fixed inset-0 z-50', className)}>
      {/* §3 scrim — click outside collapses the deck */}
      <AnimatePresence>
        {paletteOpen && (
          <motion.div
            key="floating-island-scrim"
            className="pointer-events-auto absolute inset-0 bg-void/70"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={SPRING}
            onClick={() => setPaletteOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Morphing island row: [left notches] [pill ⇄ deck] [right notches].
          top-1.5 floats the 36px island exactly in the 48px BrowserTopBar's centre. */}
      <div className="pointer-events-none absolute inset-x-0 top-1.5 flex items-start justify-center gap-2 px-3">
        {/* §B.5 left flank */}
        <div className="pointer-events-none flex items-center gap-2">
          <AnimatePresence initial={false}>
            {notches.slice(0, Math.ceil(notches.length / 2)).map((notch) => (
              <FlowNotchPill
                key={notch.regionId}
                notch={notch}
                onWakeNode={wakeFromNotch}
                onFocusFlow={focusRegionOnCanvas}
              />
            ))}
          </AnimatePresence>
        </div>

        <AnimatePresence mode="popLayout" initial={false}>
          {paletteOpen ? (
            <IslandDeck
              key="floating-island-deck"
              nav={nav}
              compact={compact}
              notches={notches}
              onOpenTab={openTabFromDeck}
              onFocusFlow={focusRegionOnCanvas}
              dragHandlers={dragHandlers}
            />
          ) : (
            /* ---------------- STAGE 0 — resting 36px pill ---------------- */
            <motion.div
              key="floating-island-pill"
              layoutId="floating-island"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, scale: isDragOver ? 1.06 : 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={SPRING}
              style={{ borderRadius: 18, boxShadow: 'var(--shadow-pop)' }}
              className={cn(
                'pointer-events-auto flex h-9 max-w-[min(52vw,_640px)] select-none items-center gap-1 border bg-surface-glass pl-1 pr-1 backdrop-blur-xl',
                isDragOver ? 'border-[color:var(--border-active)]' : 'border-hairline',
              )}
              {...dragHandlers}
            >
              {/* ---- left cluster: Back / Forward + relational dots ---- */}
              <QuietButton icon={ArrowLeft} label="Back — active tab history" onClick={onBack ?? (() => {})} disabled={!canBack || !onBack} size={12} />
              <QuietButton icon={ArrowRight} label="Forward — active tab history" onClick={onForward ?? (() => {})} disabled={!canForward || !onForward} size={12} />
              {(dots.length > 0) && <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-hairline" />}
              <span className="flex shrink-0 items-center">
                {dots.map((dot, index) => (
                  <NeighborDot
                    key={dot.uuid}
                    dot={dot}
                    index={index}
                    total={dots.length}
                    node={nodes[dot.uuid] ?? null}
                    onActivate={activateNode}
                  />
                ))}
              </span>

              {/* ---- center: favicon + domain trigger → Stage 1 ---- */}
              <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-hairline" />
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                title="Open the island deck (⌘/Ctrl+L)"
                className="flex h-7 min-w-0 items-center gap-1.5 rounded-full px-1.5 transition-colors hover:bg-[color:var(--glass-soft)]"
              >
                {activeNode ? (
                  <FaviconMark domain={activeNode.domain} size={16} />
                ) : (
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-md border border-hairline bg-[color:var(--glass-soft)] text-[color:var(--ink-muted)]">
                    <Search size={10} />
                  </span>
                )}
                {activeNode ? (
                  <span className="max-w-[168px] truncate text-[12px] text-[color:var(--ink-primary)]">{activeNode.domain}</span>
                ) : (
                  <span className="text-[12px] text-[color:var(--ink-secondary)]">Search & commands</span>
                )}
                {/* §B.1 center status: loading pulse · audio waveform · recording dot */}
                {activeNode?.isLoading && (
                  <motion.span
                    title="Loading…"
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--accent)]"
                    animate={{ opacity: [1, 0.3, 1], scale: [1, 0.75, 1] }}
                    transition={{ duration: 0.9, repeat: Infinity, ease: 'easeInOut' }}
                  />
                )}
                {activeNode?.isAudible && (
                  <motion.span
                    title="Playing audio — immune to auto-hibernation"
                    className="shrink-0 text-[color:var(--ink-secondary)]"
                    animate={{ opacity: [1, 0.5, 1] }}
                    transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
                  >
                    <AudioLines size={12} />
                  </motion.span>
                )}
                {isRecording && (
                  <motion.span
                    title="Recording voice memo on this tab"
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--accent)]"
                    animate={{ opacity: [1, 0.35, 1] }}
                    transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
                  />
                )}
                {activeNode?.isPinned && (
                  <Heart size={11} strokeWidth={1.75} className="shrink-0 text-[color:var(--ink-secondary)]" aria-hidden />
                )}
              </button>

              {/* ---- right cluster: + · Shield · ↻ · pin/heart · × ---- */}
              <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-hairline" />
              <QuietButton icon={Plus} label="New tab (⌘/Ctrl+T)" onClick={() => createNewTab()} size={12} />
              {/* Shield — count only when the desktop shell hands one over */}
              <span
                title={
                  typeof shieldBlockedCount === 'number'
                    ? `Adblock Shield — ${shieldBlockedCount} blocked`
                    : 'Adblock Shield — blocked counts arrive with the desktop shell'
                }
                className="flex h-6 shrink-0 items-center gap-1 rounded-full px-1 text-[color:var(--ink-secondary)]"
              >
                <ShieldCheck size={12} strokeWidth={1.75} aria-hidden />
                {typeof shieldBlockedCount === 'number' && (
                  <span className="text-[10px] tabular-nums text-[color:var(--ink-muted)]">{shieldBlockedCount}</span>
                )}
              </span>
              <QuietButton
                icon={RotateCw}
                label="Reload page"
                onClick={
                  onReload ??
                  (() => {
                    if (!activeNode) return
                    navigateActiveNode(activeNode.url, activeNode.title, activeNode.searchQuery ?? undefined)
                  })
                }
                size={12}
              />
              <QuietButton
                icon={Heart}
                label={activeNode?.isPinned ? 'Unpin this anchor' : 'Pin as a permanent anchor (pinning replaces bookmarks)'}
                onClick={() => activeNode && pinNode(activeNode.uuid, !activeNode.isPinned)}
                active={activeNode?.isPinned ?? false}
                disabled={!activeNode}
                size={12}
              />
              <QuietButton icon={X} label="Close tab" onClick={() => activeNode && closeNode(activeNode.uuid)} disabled={!activeNode} size={12} />
            </motion.div>
          )}
        </AnimatePresence>

        {/* §B.5 right flank */}
        <div className="pointer-events-none flex items-center gap-2">
          <AnimatePresence initial={false}>
            {notches.slice(Math.ceil(notches.length / 2)).map((notch) => (
              <FlowNotchPill
                key={notch.regionId}
                notch={notch}
                onWakeNode={wakeFromNotch}
                onFocusFlow={focusRegionOnCanvas}
              />
            ))}
          </AnimatePresence>
        </div>
      </div>

      {/* §6 drop-zone affordance — visible hint while a drag hovers the pill */}
      <AnimatePresence>
        {isDragOver && !paletteOpen && activeNode && (
          <motion.div
            key="floating-island-drop-hint"
            style={{ x: '-50%', boxShadow: 'var(--shadow-pop)' }}
            className="absolute left-1/2 top-[54px] flex items-center gap-1.5 rounded-full border border-[color:var(--border-active)] bg-surface-glass px-3 py-1 text-[11px] text-[color:var(--ink-primary)] backdrop-blur-xl"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={SPRING}
          >
            <Plus size={11} />
            Release to anchor a new tab beside&nbsp;{activeNode.domain}
          </motion.div>
        )}
      </AnimatePresence>

      {/* §6 spawn confirmation ring after a successful drop */}
      {spawnPulse > 0 && (
        <motion.span
          key={`floating-island-spawn-${spawnPulse}`}
          style={{ x: '-50%' }}
          className="pointer-events-none absolute left-1/2 top-1.5 h-9 w-9 rounded-full border-2 border-[color:var(--border-active)]"
          initial={{ opacity: 0.7, scale: 0.7 }}
          animate={{ opacity: 0, scale: 2.1 }}
          transition={SPRING}
          onAnimationComplete={() => setSpawnPulse(0)}
        />
      )}

      {/* §5.2 pool-eviction toast lives in the global chrome surface
          (ToastStack — visible in both view modes and while the deck is open). */}
    </div>
  )
}

export default FloatingIslandPill
