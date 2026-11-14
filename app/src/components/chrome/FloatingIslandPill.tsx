/**
 * app/src/components/chrome/FloatingIslandPill.tsx — the Blanc floating
 * island (SPEC §3 Mode A) rebuilt for the Phase 1.5 flagship chrome
 * (ZCODE_MASTER_PROMPT.md §Phase 1.5.2).
 *
 * RESTING STATE (36px island, floating exactly in the BrowserTopBar's
 * reserved centre slot): neutral favicon mark, the domain/title trigger that
 * opens the command palette (⌘/Ctrl+L wired app-globally), a loading pulse,
 * the audio-immunity indicator, up to 6 neighbour dots with SILENT state
 * semantics (§6: filled = live, hollow = asleep, frosted wash = Ghost Echo —
 * muted tones, never neon), and the Alt+N quick-note +
 * Canvas-toggle quick actions. ALL RAM/debug badges are stripped: no
 * `LIVE · 138 MB`, no `SLEEP · 0 MB`, no `AUTH`, no uppercase mono chips.
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
  Search,
  StickyNote,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import {
  SLASH_COMMANDS,
  SPATIAL_DRAG_MIME,
  domainOf,
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
        'rounded border border-hairline bg-[color:var(--glass-soft)] px-1 font-mono text-[9px] leading-[15px] text-[color:var(--ink-muted)]',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

/** Neutral favicon mark — the chrome owns no hue (thumbnails own the color). */
function FaviconMark({ domain }: { domain: string }) {
  const letter = (domain[0] ?? '?').toUpperCase()
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-hairline bg-[color:var(--glass-soft)] text-[10px] font-semibold text-[color:var(--ink-secondary)]">
      {letter}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* §6 neighbour dots — silent state grammar, muted tones, never neon:  */
/*   filled = live · hollow = asleep · frosted wash = Ghost Echo.      */
/* First dot is always the active node.                                */
/* ------------------------------------------------------------------ */

const DOT_CORE: Record<PillNeighborDotState, string> = {
  active: 'h-2.5 w-2.5 rounded-full bg-[color:var(--accent)]',
  loading: '', // rendered as a pulsing motion.span below
  live: 'h-2 w-2 rounded-full bg-[color:var(--ink-secondary)]',
  hibernated: 'h-2 w-2 rounded-full border-[1.5px] border-[color:var(--ink-muted)] bg-transparent',
  // Frosted ghost — quietest wash inside a muted hairline, zero glow.
  ghost: 'h-2 w-2 rounded-full border border-[color:var(--ink-muted)] bg-[color:var(--glass-soft)]',
}

const DOT_LABEL: Record<PillNeighborDotState, string> = {
  active: 'Active tab',
  loading: 'Loading…',
  live: 'Live tab',
  hibernated: 'Asleep — click to wake',
  ghost: 'Ghost echo — predicted resurfacing',
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
          className="h-2 w-2 rounded-full bg-[color:var(--accent)]"
          animate={{ scale: [1, 1.5, 1], opacity: [1, 0.4, 1] }}
          transition={{ duration: 1.05, repeat: Infinity, ease: 'easeInOut' }}
        />
      </button>
    )
  }
  return (
    <button
      type="button"
      title={`${dot.title} — ${DOT_LABEL[dot.state]}`}
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
}

/** Quiet sentence-case result categories — no uppercase mono chips. */
const RESULT_META: Record<SearchResultKind, { icon: LucideIcon; label: string }> = {
  tab: { icon: PanelTop, label: 'Tab' },
  note: { icon: StickyNote, label: 'Note' },
  memo: { icon: AudioLines, label: 'Memo' },
}

function PaletteRow({
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
      className="relative flex h-10 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left"
    >
      {selected && (
        <motion.span
          layoutId="floating-island-selection"
          className="absolute inset-0 rounded-[10px] bg-[color:var(--glass-soft)]"
          transition={SPRING}
        />
      )}
      <span className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-hairline bg-[color:var(--glass-soft)] text-[color:var(--ink-secondary)]">
        <Icon size={13} />
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
      style={{ borderRadius: 18, boxShadow: 'var(--shadow-pop)' }}
      className="pointer-events-auto flex w-[680px] max-w-[calc(100vw_-_24px)] flex-col overflow-hidden border border-hairline bg-surface-glass backdrop-blur-xl"
      {...dragHandlers}
    >
      {/* search input row */}
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-hairline px-3.5">
        <Search size={15} className="shrink-0 text-[color:var(--ink-muted)]" />
        <input
          autoFocus
          value={query}
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value)
            setSelectedIndex(0)
          }}
          placeholder="Search tabs, notes, voice memos — or type / for commands"
          className="h-full min-w-0 flex-1 bg-transparent text-[13.5px] text-[color:var(--ink-primary)] outline-none placeholder:text-[color:var(--ink-muted)]"
        />
        <Kbd>esc</Kbd>
      </div>

      {/* results / commands */}
      <div
        ref={listRef}
        className="max-h-[336px] overflow-y-auto overscroll-contain p-1.5 [scrollbar-color:var(--border-hover)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[color:var(--border-hover)]"
      >
        {items.length > 0 && (
          <div className="px-2.5 pb-1 pt-2 text-[10px] text-[color:var(--ink-muted)]">
            {isCommandsView ? 'Commands' : 'Results'}
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
            />
          )
        })}
        {items.length === 0 && (
          <div className="flex h-20 items-center justify-center px-4 text-center text-[12px] text-[color:var(--ink-muted)]">
            {slashFilter !== null
              ? `No command matches “${trimmed}” — try /canvas or /note`
              : `No matches for “${trimmed}” in tabs, notes or voice memos`}
          </div>
        )}
      </div>

      {/* shortcut hints footer (mono reserved for <kbd> hints) */}
      <div className="flex h-8 shrink-0 items-center gap-3 border-t border-hairline px-3.5 text-[10px] text-[color:var(--ink-muted)]">
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
        <span className="ml-auto tabular-nums">
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
  const paletteOpen = useGraphStore((s) => s.paletteOpen)
  const recordingNodeId = useGraphStore((s) => s.recordingNodeId)

  /* --- store actions (stable references) --- */
  const setPaletteOpen = useGraphStore((s) => s.setPaletteOpen)
  const toggleCanvas = useGraphStore((s) => s.toggleCanvas)
  const quickNoteOnActive = useGraphStore((s) => s.quickNoteOnActive)
  const spawnChildNode = useGraphStore((s) => s.spawnChildNode)
  const activateNode = useGraphStore((s) => s.activateNode)

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

      {/* Morphing island shell: resting pill ⇄ command palette (shared layout spring).
          top-1.5 floats the 36px island exactly in the 48px BrowserTopBar's centre. */}
      <div className="pointer-events-none absolute inset-x-0 top-1.5 flex justify-center">
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
              style={{ borderRadius: 18, boxShadow: 'var(--shadow-pop)' }}
              className={cn(
                'pointer-events-auto flex h-9 max-w-[min(46vw,_560px)] select-none items-center gap-1.5 border bg-surface-glass pl-1.5 pr-1 backdrop-blur-xl',
                isDragOver ? 'border-[color:var(--border-active)]' : 'border-hairline',
              )}
              {...dragHandlers}
            >
              {/* neutral favicon */}
              {activeNode ? (
                <span title={`${activeNode.title} — ${activeNode.url}`} className="ml-0.5 flex shrink-0">
                  <FaviconMark domain={activeNode.domain} />
                </span>
              ) : (
                <span className="ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-hairline bg-[color:var(--glass-soft)] text-[color:var(--ink-muted)]">
                  <Search size={11} />
                </span>
              )}

              {/* pill centre — the domain/title trigger that opens the palette
                  (⌘/Ctrl+L is wired app-globally, §10) */}
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                title="Search & commands (⌘/Ctrl+L)"
                className="flex h-7 min-w-0 items-center gap-1.5 rounded-full px-1.5 transition-colors hover:bg-[color:var(--glass-soft)]"
              >
                <Search size={12} className="shrink-0 text-[color:var(--ink-muted)]" />
                {activeNode ? (
                  <span className="max-w-[180px] truncate text-[12px] text-[color:var(--ink-primary)]">
                    {activeNode.domain}
                  </span>
                ) : (
                  <span className="text-[12px] text-[color:var(--ink-secondary)]">Search & commands</span>
                )}
              </button>

              {/* simulated navigation pulse (§6 "pulsing = loading") */}
              {activeNode?.isLoading && (
                <motion.span
                  title="Loading…"
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--accent)]"
                  animate={{ opacity: [1, 0.3, 1], scale: [1, 0.75, 1] }}
                  transition={{ duration: 0.9, repeat: Infinity, ease: 'easeInOut' }}
                />
              )}

              {/* §5.3 audio immunity indicator */}
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

              {/* §5.3 voice-memo recording indicator */}
              {isRecording && (
                <motion.span
                  title="Recording voice memo on this tab"
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--accent)]"
                  animate={{ opacity: [1, 0.35, 1] }}
                  transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
                />
              )}

              {/* §6 neighbour dots — max 6, active first, silent semantics */}
              {dots.length > 0 && <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-hairline" />}
              <span className="flex shrink-0 items-center gap-1">
                {dots.map((dot) => (
                  <NeighborDot key={dot.uuid} dot={dot} onActivate={activateNode} />
                ))}
              </span>

              {/* quick actions */}
              <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-hairline" />
              <button
                type="button"
                onClick={() => quickNoteOnActive()}
                disabled={!activeNode}
                title="Add sticky note (Alt+N)"
                className="flex size-6 shrink-0 items-center justify-center rounded-full text-[color:var(--ink-secondary)] transition-colors hover:bg-[color:var(--glass-soft)] hover:text-[color:var(--ink-primary)] disabled:pointer-events-none disabled:opacity-40"
              >
                <StickyNote size={12} />
              </button>
              <button
                type="button"
                onClick={() => toggleCanvas()}
                title="Toggle spatial canvas (⌘/Ctrl+Space or Alt+Space)"
                className="flex size-6 shrink-0 items-center justify-center rounded-full text-[color:var(--ink-secondary)] transition-colors hover:bg-[color:var(--glass-soft)] hover:text-[color:var(--ink-primary)]"
              >
                <LayoutGrid size={12} />
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
          (ToastStack — visible in both view modes and while the palette is open). */}
    </div>
  )
}

export default FloatingIslandPill
