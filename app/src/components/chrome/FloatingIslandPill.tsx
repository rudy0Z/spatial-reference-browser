/**
 * app/src/components/chrome/FloatingIslandPill.tsx — SPEC §3 Mode A chrome:
 * the Blanc Floating Island Pill + Raycast-style command palette.
 *
 * RESTING STATE (36px tall, top-center): deterministic favicon mark, clean
 * domain, mono `LIVE · 138 MB` / `SLEEP · 0 MB` RAM badge, up to 6 neighbour
 * dots from `selectPillNeighbours` (§6 semantics: accent = active, pulsing =
 * loading, hollow = hibernated, violet glow = Ghost Echo), plus quick
 * actions — Add Note (Alt+N equivalent) and Toggle Canvas (⌘/Ctrl+Space
 * equivalent). Clicking the pill center opens the palette (⌘/Ctrl+L is
 * wired globally by the app shell per §10 — this component only consumes
 * the `paletteOpen` flag, so the two never double-toggle).
 *
 * PALETTE: the pill shell morphs into a 680px Raycast-style command bar via
 * a framer-motion shared-layout spring (stiffness 380 / damping 30, §2).
 * Fuzzy search runs through `selectSearchResults` (tabs + sticky note text +
 * voice-note titles); `/` filters the six `SLASH_COMMANDS`. ArrowUp/Down +
 * Enter navigate/run, Esc or scrim click closes. Query state lives inside
 * the palette subcomponent, which mounts only while open — so it resets
 * naturally without reset effects.
 *
 * DRAG-TO-ANCHOR (§6): the shell is a drop target for `SPATIAL_DRAG_MIME`
 * payloads (JSON `SpatialDragPayload` set by MockWebReader) with a
 * text/uri-list + text/plain fallback; a valid drop spawns a live satellite
 * adjacent to the active node via `spawnChildNode`.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AudioLines,
  Boxes,
  LayoutGrid,
  Moon,
  PanelTop,
  Plus,
  Rocket,
  Search,
  StickyNote,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { fnv1a32 } from '../../lib/embed'
import {
  REGION_COLORS,
  SLASH_COMMANDS,
  SPATIAL_DRAG_MIME,
  domainOf,
  formatRamMb,
} from '../../lib/types'
import type {
  FloatingIslandPillProps,
  PillNeighborDot,
  PillNeighborDotState,
  SearchResult,
  SearchResultKind,
  SlashCommand,
  SlashCommandId,
  SpatialDragPayload,
} from '../../lib/types'
import { selectPillNeighbours, selectSearchResults, useGraphStore } from '../../store/useGraphStore'
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
 * file only subscribes to the record maps they actually read. This adapter
 * lets the memos run on the subscribed slices (kept reactive through the same
 * deps) without calling `useGraphStore.getState()` inside render.
 */
type SelectorStateCore = Partial<Pick<GraphStore, 'nodes' | 'edges' | 'notes' | 'voiceMemos'>>

function asSelectorState(core: SelectorStateCore): GraphStore {
  return core as unknown as GraphStore
}

function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'rounded border border-white/10 bg-white/[0.05] px-1 font-mono text-[9px] leading-[15px] text-white/45',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

/** Deterministic favicon tint for the active tab (region color wins if any). */
function accentColorForDomain(domain: string): string {
  return REGION_COLORS[fnv1a32(domain) % REGION_COLORS.length] ?? REGION_COLORS[0]
}

function FaviconMark({ domain, color }: { domain: string; color: string }) {
  const letter = (domain[0] ?? '?').toUpperCase()
  return (
    <span
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold"
      style={{ backgroundColor: `${color}26`, color, boxShadow: `inset 0 0 0 1px ${color}40` }}
    >
      {letter}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* §6 neighbour dots — accent=active, pulsing=loading, hollow=sleeping, */
/* violet glow=Ghost Echo. First dot is always the active node.        */
/* ------------------------------------------------------------------ */

const DOT_CORE: Record<PillNeighborDotState, string> = {
  active: 'h-2.5 w-2.5 rounded-full bg-accent shadow-[0_0_10px_rgba(110,231,183,0.55)] ring-1 ring-accent/40',
  loading: '', // rendered as a pulsing motion.span below
  live: 'h-2 w-2 rounded-full bg-white/75',
  hibernated: 'h-2 w-2 rounded-full border border-white/50 bg-transparent',
  ghost: 'h-2 w-2 rounded-full bg-ghost shadow-[0_0_9px_rgba(167,139,250,0.9)]',
}

function NeighborDot({ dot, onActivate }: { dot: PillNeighborDot; onActivate: (uuid: string) => void }) {
  if (dot.state === 'loading') {
    return (
      <button
        type="button"
        title={`${dot.title} — loading`}
        onClick={() => onActivate(dot.uuid)}
        className="flex h-4 w-4 items-center justify-center"
      >
        <motion.span
          className="h-2 w-2 rounded-full bg-accent"
          animate={{ scale: [1, 1.5, 1], opacity: [1, 0.4, 1] }}
          transition={{ duration: 1.05, repeat: Infinity, ease: 'easeInOut' }}
        />
      </button>
    )
  }
  return (
    <button
      type="button"
      title={`${dot.title} — ${dot.state === 'active' ? 'active' : dot.state === 'ghost' ? 'ghost echo' : dot.state}`}
      onClick={() => onActivate(dot.uuid)}
      className="flex h-4 w-4 items-center justify-center"
    >
      <span className={DOT_CORE[dot.state]} />
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* Palette rows — slash commands + fuzzy search results                */
/* ------------------------------------------------------------------ */

type PaletteItem =
  | { type: 'command'; command: SlashCommand }
  | { type: 'result'; result: SearchResult }

const COMMAND_ICONS: Record<SlashCommandId, LucideIcon> = {
  canvas: LayoutGrid,
  'hibernate-all': Moon,
  new: Plus,
  note: StickyNote,
  cluster: Boxes,
  'seed-600': Rocket,
}

const RESULT_META: Record<SearchResultKind, { icon: LucideIcon; label: string; chip: string }> = {
  tab: { icon: PanelTop, label: 'TAB', chip: 'border-accent/25 bg-accent/10 text-accent' },
  note: { icon: StickyNote, label: 'NOTE', chip: 'border-sticky/25 bg-sticky-glass text-sticky' },
  memo: { icon: AudioLines, label: 'MEMO', chip: 'border-[#22D3EE]/25 bg-[#22D3EE]/10 text-[#22D3EE]' },
}

function PaletteRow({
  selected,
  onSelect,
  onRun,
  icon: Icon,
  title,
  detail,
  chip,
  chipClass,
}: {
  selected: boolean
  onSelect: () => void
  onRun: () => void
  icon: LucideIcon
  title: string
  detail: string
  chip: string | null
  chipClass: string
}) {
  return (
    <button
      type="button"
      data-selected={selected}
      onClick={onRun}
      onMouseEnter={onSelect}
      className="relative flex h-10 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left"
    >
      {selected && (
        <motion.span
          layoutId="floating-island-selection"
          className="absolute inset-0 rounded-[10px] bg-white/[0.07]"
          transition={SPRING}
        />
      )}
      <span className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.05] text-white/70">
        <Icon size={13} />
      </span>
      <span className="relative z-10 min-w-0 flex-1 truncate text-[12.5px] text-white/85">{title}</span>
      {detail !== '' && (
        <span className="relative z-10 hidden max-w-[45%] shrink truncate text-[10.5px] text-white/40 sm:block">
          {detail}
        </span>
      )}
      {chip !== null && (
        <span
          className={cn(
            'relative z-10 shrink-0 rounded border px-1 font-mono text-[8.5px] uppercase leading-[14px]',
            chipClass,
          )}
        >
          {chip}
        </span>
      )}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* §6 drag-to-anchor — pill ⇄ reader contract                          */
/* ------------------------------------------------------------------ */

/** Drag handlers shared by the resting pill shell and the palette shell. */
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
/* Command palette — mounts only while `paletteOpen` is true, so its   */
/* query/selection state resets naturally between sessions.            */
/* ------------------------------------------------------------------ */

function CommandPalette({ dragHandlers }: { dragHandlers: ShellDragHandlers }) {
  const nodes = useGraphStore((s) => s.nodes)
  const notes = useGraphStore((s) => s.notes)
  const voiceMemos = useGraphStore((s) => s.voiceMemos)

  const setPaletteOpen = useGraphStore((s) => s.setPaletteOpen)
  const toggleCanvas = useGraphStore((s) => s.toggleCanvas)
  const quickNoteOnActive = useGraphStore((s) => s.quickNoteOnActive)
  const openNodeInViewport = useGraphStore((s) => s.openNodeInViewport)
  const hibernateAll = useGraphStore((s) => s.hibernateAll)
  const createNewTab = useGraphStore((s) => s.createNewTab)
  const createClusterFromActive = useGraphStore((s) => s.createClusterFromActive)
  const seed600 = useGraphStore((s) => s.seed600)

  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  const trimmed = query.trim()
  /** null = not a slash query; '' = bare "/" (all commands); otherwise the prefix after "/". */
  const slashFilter = trimmed.startsWith('/') ? trimmed.slice(1).trim().toLowerCase() : null

  const filteredCommands = useMemo(() => {
    if (slashFilter === null) return SLASH_COMMANDS
    return SLASH_COMMANDS.filter(
      (command) => command.id.startsWith(slashFilter) || command.label.toLowerCase().startsWith(trimmed.toLowerCase()),
    )
  }, [slashFilter, trimmed])

  /** §3 fuzzy search across tabs, note text and voice-note titles (store selector). */
  const searchResults = useMemo<SearchResult[]>(
    () =>
      trimmed === '' || slashFilter !== null
        ? []
        : selectSearchResults(asSelectorState({ nodes, notes, voiceMemos }), query, 12),
    [query, trimmed, slashFilter, nodes, notes, voiceMemos],
  )

  const items = useMemo<PaletteItem[]>(
    () =>
      slashFilter !== null || trimmed === ''
        ? filteredCommands.map((command) => ({ type: 'command' as const, command }))
        : searchResults.map((result) => ({ type: 'result' as const, result })),
    [slashFilter, trimmed, filteredCommands, searchResults],
  )

  /** Derived clamp — no effect needed when the list shrinks under the cursor. */
  const safeIndex = Math.min(selectedIndex, Math.max(0, items.length - 1))

  /** Keep the spring-highlighted selection visible in the scroll list. */
  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [safeIndex, items])

  const runCommand = (id: SlashCommandId) => {
    switch (id) {
      case 'canvas':
        toggleCanvas()
        break
      case 'hibernate-all':
        hibernateAll()
        break
      case 'new':
        createNewTab()
        break
      case 'note':
        quickNoteOnActive()
        break
      case 'cluster':
        createClusterFromActive()
        break
      case 'seed-600':
        seed600()
        break
    }
    setPaletteOpen(false)
  }

  const runItem = (item: PaletteItem) => {
    if (item.type === 'command') {
      runCommand(item.command.id)
      return
    }
    if (item.result.nodeId) openNodeInViewport(item.result.nodeId)
    setPaletteOpen(false)
  }

  const handlePaletteKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setPaletteOpen(false)
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (items.length > 0) setSelectedIndex((current) => (Math.min(current, items.length - 1) + 1) % items.length)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (items.length > 0)
        setSelectedIndex((current) => (Math.min(current, items.length - 1) - 1 + items.length) % items.length)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const item = items[safeIndex]
      if (item) runItem(item)
    }
  }

  const isCommandsView = slashFilter !== null || trimmed === ''

  return (
    <motion.div
      layoutId="floating-island"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={SPRING}
      onKeyDown={handlePaletteKeyDown}
      style={{ borderRadius: 18 }}
      className="pointer-events-auto flex w-[680px] max-w-[calc(100vw_-_24px)] flex-col overflow-hidden border border-hairline bg-surface-glass shadow-[0_24px_80px_rgba(0,0,0,0.7)] backdrop-blur-xl"
      {...dragHandlers}
    >
      {/* search input row */}
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-hairline px-3.5">
        <Search size={15} className="shrink-0 text-white/40" />
        <input
          autoFocus
          value={query}
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value)
            setSelectedIndex(0)
          }}
          placeholder="Search tabs, notes, voice memos — or type / for commands"
          className="h-full min-w-0 flex-1 bg-transparent text-[13.5px] text-white/90 outline-none placeholder:text-white/30"
        />
        <Kbd>esc</Kbd>
      </div>

      {/* results / commands */}
      <div
        ref={listRef}
        className="max-h-[336px] overflow-y-auto overscroll-contain p-1.5 [scrollbar-color:rgba(255,255,255,0.14)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/10"
      >
        {items.length > 0 && (
          <div className="px-2.5 pb-1 pt-2 font-mono text-[9px] uppercase tracking-[0.16em] text-white/30">
            {isCommandsView ? 'Slash commands' : 'Search results'}
          </div>
        )}
        {items.map((item, index) => {
          const selected = index === safeIndex
          if (item.type === 'command') {
            const Icon = COMMAND_ICONS[item.command.id]
            return (
              <PaletteRow
                key={`cmd-${item.command.id}`}
                selected={selected}
                onSelect={() => setSelectedIndex(index)}
                onRun={() => runItem(item)}
                icon={Icon}
                title={item.command.label}
                detail={item.command.description}
                chip={null}
                chipClass=""
              />
            )
          }
          const meta = RESULT_META[item.result.kind]
          return (
            <PaletteRow
              key={`${item.result.kind}-${item.result.id}`}
              selected={selected}
              onSelect={() => setSelectedIndex(index)}
              onRun={() => runItem(item)}
              icon={meta.icon}
              title={item.result.title}
              detail={item.result.snippet}
              chip={meta.label}
              chipClass={meta.chip}
            />
          )
        })}
        {items.length === 0 && (
          <div className="flex h-20 items-center justify-center px-4 text-center text-[12px] text-white/35">
            {slashFilter !== null
              ? `No command matches “${trimmed}” — try /canvas or /seed-600`
              : `No matches for “${trimmed}” in tabs, notes or voice memos`}
          </div>
        )}
      </div>

      {/* shortcut hints footer (§10 on-screen chips) */}
      <div className="flex h-8 shrink-0 items-center gap-3 border-t border-hairline px-3.5 text-[10px] text-white/35">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> navigate
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd> run
        </span>
        <span className="flex items-center gap-1">
          <Kbd>esc</Kbd> close
        </span>
        <span className="ml-auto font-mono">
          {items.length} {isCommandsView ? 'commands' : 'results'}
        </span>
      </div>
    </motion.div>
  )
}

/* ------------------------------------------------------------------ */
/* FloatingIslandPill                                                  */
/* ------------------------------------------------------------------ */

export function FloatingIslandPill({ className }: FloatingIslandPillProps) {
  /* --- store state (narrow selectors; records/maps keep identity until changed) --- */
  const activeNode = useGraphStore((s) => (s.activeNodeUuid ? (s.nodes[s.activeNodeUuid] ?? null) : null))
  const nodes = useGraphStore((s) => s.nodes)
  const edges = useGraphStore((s) => s.edges)
  const regions = useGraphStore((s) => s.regions)
  const paletteOpen = useGraphStore((s) => s.paletteOpen)
  const recordingNodeId = useGraphStore((s) => s.recordingNodeId)

  /* --- store actions (stable references) --- */
  const setPaletteOpen = useGraphStore((s) => s.setPaletteOpen)
  const toggleCanvas = useGraphStore((s) => s.toggleCanvas)
  const quickNoteOnActive = useGraphStore((s) => s.quickNoteOnActive)
  const spawnChildNode = useGraphStore((s) => s.spawnChildNode)
  const activateNode = useGraphStore((s) => s.activateNode)

  /* --- derived view model --- */
  const regionColor = activeNode?.regionId ? (regions[activeNode.regionId]?.color ?? null) : null
  const faviconColor = regionColor ?? (activeNode ? accentColorForDomain(activeNode.domain) : REGION_COLORS[0])
  const isRecording = recordingNodeId !== null && activeNode?.uuid === recordingNodeId

  /** §6 dots — recompute when the graph actually changes (memoized, not per-render). */
  const dots = useMemo(
    () => (activeNode ? selectPillNeighbours(asSelectorState({ nodes, edges }), activeNode.uuid) : []),
    [activeNode, nodes, edges],
  )

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

  /* ------------------------------------------------------------------ */

  return (
    <div className={cn('pointer-events-none fixed inset-0 z-50', className)}>
      {/* §3 scrim — click outside closes the palette */}
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

      {/* Morphing island shell: resting pill ⇄ command palette (shared layout spring) */}
      <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
        <AnimatePresence>
          {paletteOpen ? (
            <CommandPalette key="floating-island-palette" dragHandlers={dragHandlers} />
          ) : (
            /* ---------------- resting 36px pill ---------------- */
            <motion.div
              key="floating-island-pill"
              layoutId="floating-island"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, scale: isDragOver ? 1.06 : 1 }}
              transition={SPRING}
              style={{ borderRadius: 18 }}
              className={cn(
                'pointer-events-auto flex h-9 max-w-[min(92vw,_560px)] select-none items-center gap-1.5 border bg-surface-glass pl-1.5 pr-1 backdrop-blur-xl',
                isDragOver
                  ? 'border-accent/60 shadow-[0_0_26px_rgba(52,211,153,0.35)]'
                  : 'border-hairline shadow-[0_10px_36px_rgba(0,0,0,0.6)]',
              )}
              {...dragHandlers}
            >
              {/* favicon */}
              {activeNode ? (
                <span title={`${activeNode.title} — ${activeNode.url}`} className="ml-0.5 flex shrink-0">
                  <FaviconMark domain={activeNode.domain} color={faviconColor} />
                </span>
              ) : (
                <span className="ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/5 text-white/40">
                  <Search size={11} />
                </span>
              )}

              {/* pill center — opens the palette (⌘/Ctrl+L is wired app-globally, §10) */}
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                title="Search & commands (⌘/Ctrl+L)"
                className="flex h-7 min-w-0 items-center gap-1.5 rounded-full px-1.5 transition-colors hover:bg-white/[0.07]"
              >
                <Search size={12} className="shrink-0 text-white/45" />
                {activeNode ? (
                  <span className="max-w-[150px] truncate font-mono text-[11.5px] text-white/85">
                    {activeNode.domain}
                  </span>
                ) : (
                  <span className="text-[11.5px] text-white/55">Command bar</span>
                )}
                <Kbd>⌘L</Kbd>
              </button>

              {/* mono RAM badge — §2 JetBrains Mono, §4.1/4.2 badge copy */}
              {activeNode && (
                <span
                  title={activeNode.ramState === 'live' ? 'Live tab — resident memory' : 'Hibernated — 0 MB'}
                  className={cn(
                    'flex h-5 shrink-0 items-center rounded-md border px-1.5 font-mono text-[9.5px]',
                    activeNode.ramState === 'live'
                      ? 'border-accent/25 bg-accent/10 text-accent'
                      : 'border-white/10 bg-white/5 text-white/45',
                  )}
                >
                  {activeNode.ramState === 'live' ? 'LIVE' : 'SLEEP'} · {formatRamMb(activeNode.ramMb)}
                </span>
              )}

              {/* simulated navigation pulse (§6 "pulsing = loading") */}
              {activeNode?.isLoading && (
                <motion.span
                  title="Loading…"
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                  animate={{ opacity: [1, 0.3, 1], scale: [1, 0.75, 1] }}
                  transition={{ duration: 0.9, repeat: Infinity, ease: 'easeInOut' }}
                />
              )}

              {/* §5.3 audio immunity indicator */}
              {activeNode?.isAudible && (
                <motion.span
                  title="Playing audio — immune to auto-hibernation"
                  className="shrink-0 text-accent"
                  animate={{ opacity: [1, 0.5, 1] }}
                  transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
                >
                  <AudioLines size={12} />
                </motion.span>
              )}

              {/* §5.3 voice-memo recording indicator */}
              {isRecording && (
                <motion.span
                  title="Recording voice memo on this tab"
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#FB7185]"
                  animate={{ opacity: [1, 0.35, 1] }}
                  transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
                />
              )}

              {/* §7.2 collapsed auth/payment redirect tag */}
              {activeNode?.viaAuth && (
                <span
                  title="OAuth/payment redirect chain collapsed into this node"
                  className="shrink-0 rounded border border-white/10 bg-white/5 px-1 font-mono text-[8.5px] leading-[14px] text-white/45"
                >
                  AUTH
                </span>
              )}

              {/* §6 neighbour dots — max 6, active first */}
              {dots.length > 0 && <span className="mx-0.5 h-4 w-px shrink-0 bg-white/10" />}
              <span className="flex shrink-0 items-center gap-1">
                {dots.map((dot) => (
                  <NeighborDot key={dot.uuid} dot={dot} onActivate={activateNode} />
                ))}
              </span>

              {/* quick actions */}
              <span className="mx-0.5 h-4 w-px shrink-0 bg-white/10" />
              <button
                type="button"
                onClick={() => quickNoteOnActive()}
                disabled={!activeNode}
                title="Add sticky note (Alt+N)"
                className="flex h-6 shrink-0 items-center gap-1 rounded-full px-1.5 text-white/60 transition-colors hover:bg-white/[0.07] hover:text-sticky disabled:pointer-events-none disabled:opacity-40"
              >
                <StickyNote size={12} />
                <Kbd>⌥N</Kbd>
              </button>
              <button
                type="button"
                onClick={() => toggleCanvas()}
                title="Toggle spatial canvas (⌘/Ctrl+Space or Alt+Space)"
                className="flex h-6 shrink-0 items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-1.5 text-white/70 transition-colors hover:border-accent/40 hover:text-accent"
              >
                <LayoutGrid size={12} />
                <Kbd>⌘␣</Kbd>
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* §6 drop-zone affordance — visible hint while a drag hovers the pill */}
      <AnimatePresence>
        {isDragOver && !paletteOpen && activeNode && (
          <motion.div
            key="floating-island-drop-hint"
            style={{ x: '-50%' }}
            className="absolute left-1/2 top-[54px] flex items-center gap-1.5 rounded-full border border-accent/40 bg-surface-glass px-3 py-1 text-[11px] text-accent shadow-[0_8px_28px_rgba(0,0,0,0.6)] backdrop-blur-xl"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={SPRING}
          >
            <Plus size={11} />
            Release to spawn a satellite beside&nbsp;<span className="font-mono">{activeNode.domain}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* §6 spawn confirmation ring after a successful drop */}
      {spawnPulse > 0 && (
        <motion.span
          key={`floating-island-spawn-${spawnPulse}`}
          style={{ x: '-50%' }}
          className="pointer-events-none absolute left-1/2 top-3 h-9 w-9 rounded-full border-2 border-accent"
          initial={{ opacity: 0.7, scale: 0.7 }}
          animate={{ opacity: 0, scale: 2.1 }}
          transition={SPRING}
          onAnimationComplete={() => setSpawnPulse(0)}
        />
      )}

      {/* §5.2 pool-eviction toast lives in the global chrome surface
          (ToastStack — visible in both view modes and while the palette is open). */}
    </div>
  )
}

export default FloatingIslandPill
