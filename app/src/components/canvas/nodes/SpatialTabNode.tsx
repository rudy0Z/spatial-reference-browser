/**
 * app/src/components/canvas/nodes/SpatialTabNode.tsx — the spatial tab card
 * (SPEC §4: 3 semantic zoom levels × 6 visual states, §6 founder addenda,
 * §7 edge cases) — Phase 1.5 "Zen × Blanc × Obsidian Minimal" reskin.
 *
 * Rendered by @xyflow/react as the custom node type `spatialTab`. The record
 * and per-node flags flow in through `SpatialTabNodeData` (built per render
 * by SpatialCanvas); the §4 semantic-zoom tier arrives through
 * `CanvasLodContext` so tier crossings never rebuild React Flow's node
 * store. The component only subscribes to the store for
 * the slices it genuinely needs to own interactions:
 *   - `selectNotesForNode` / `selectMemosForNode` — rich tier only (inline
 *     sticky-note editing + real MediaRecorder playback)
 *   - `recordingNodeId` — to surface the recording panel on this card
 *   - every mutation goes through `useGraphStore.getState()` in handlers
 *
 * LOD tiers (§4):
 *   macro   — ~24px pure beacons + region-cluster titles, heavy DOM unmounted
 *   compact — sleek 180×44 pill: favicon + truncated title + micro-dots + pin
 *   rich    — full 260px editorial reference card: edge-to-edge 16:10
 *             PreviewArt render on top, clean 36px footer (14px favicon,
 *             one-line 12.5px title, 11px muted domain)
 *
 * SILENT STATE GRAMMAR (Phase 1.5 — zero uppercase debug badges anywhere):
 *   live        — tiny 5px accent dot beside the favicon
 *   loading     — the same dot pulses + a quiet shimmer sweeps the preview
 *   hibernated  — plain resting card (no SLEEP · 0 MB badge, no text)
 *   >14 days    — whole card at opacity 0.58, preview slightly desaturated
 *                 (no COLD ARCHIVE chip)
 *   pinned      — small corner pin glyph while pinned or hovered (never
 *                 ANCHOR / UNREGIONED / WB text)
 *   ghost echo  — frosted translucent card at opacity 0.55 with a 1px
 *                 rgba(255,255,255,0.12) border, quietly labelled "Related
 *                 earlier"; hover reveals Open + dismiss (no GHOST ECHO ·
 *                 92% MATCH text, no dashed borders, no violet)
 *   hover       — a floating 4-icon micro-toolbar in the preview's top-right:
 *                 Open · Pin · Note · Sleep (Sleep only on live tabs; there
 *                 is no close/destroy action in the store for hibernated
 *                 reference cards)
 *
 * State-grammar surfaces (index.css): rest = 1px var(--border-subtle),
 * hover = 1px var(--border-hover), active/selected = 1px
 * var(--border-active) + var(--shadow-card). Never colored glows. All color
 * lives in the PreviewArt render; the chrome is dead-neutral and flips with
 * the theme tokens.
 *
 * Kept intact from Phase 1 (behavior, not looks): the §6 drag-vs-click
 * guard, SPA subPages filmstrip (§7.3), cached-text excerpt modal (§7.5),
 * noCapture blur placeholder (§7.4), sticky notes on url_hash (§7.6), voice
 * memos + recording panel (§4.4), collapsed macro-stacks (§4.5), hub router
 * chips (§7.1), and the memo comparator that keeps 600 stress nodes from
 * re-rendering on pan/zoom.
 *
 * Motion: framer-motion springs stiffness 380 / damping 30 everywhere except
 * the macro tier, which stays motion-free for the 600-node stress run.
 */
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Handle, Position } from '@xyflow/react'
import { AnimatePresence, motion } from 'framer-motion'
import type { Transition } from 'framer-motion'
import {
  ArrowUpRight,
  CameraOff,
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileText,
  Film,
  Layers,
  Lock,
  Mic,
  Moon,
  Network,
  Pause,
  Pin,
  Play,
  Search,
  Square,
  StickyNote,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { barProfileFor, LIVE_LEVEL_BARS, useVoiceRecorder } from '../../../hooks/useVoiceRecorder'
import { selectMemosForNode, selectNotesForNode, useGraphStore } from '../../../store/useGraphStore'
import { formatDurationMs, isColdArchive } from '../../../lib/types'
import type {
  SpatialTabNodeProps,
  SpatialTabNodeRecord,
  StickyNote as StickyNoteRecord,
  VoiceMemo,
} from '../../../lib/types'
import { useShallow } from 'zustand/react/shallow'
import { CanvasLodContext } from '../canvasLodContext'
import { PreviewArt, previewSpecForNode } from './PreviewArt'

/* ------------------------------------------------------------------ */
/* Shared motion + style plumbing                                      */
/* ------------------------------------------------------------------ */

/** SPEC §2 motion language — one spring for the whole node card. */
const SPRING: Transition = { type: 'spring', stiffness: 380, damping: 30 }

const cn = (...inputs: Parameters<typeof clsx>) => twMerge(clsx(...inputs))

const STN_STYLE_ELEMENT_ID = 'stn-node-keyframes'

/**
 * Keyframes for the cheap CSS loops (equalizer bars, loading shimmer,
 * record blink). Injected once per document instead of a <style> tag per
 * node — 600 stress nodes must not each ship their own copy. The Phase 1
 * ghost-breathing glow is gone: ghosts are static frosted cards now.
 */
const STN_KEYFRAME_CSS = `
@keyframes stn-eq-bounce { 0%, 100% { transform: scaleY(0.3); } 50% { transform: scaleY(1); } }
@keyframes stn-shimmer-slide { 0% { transform: translateX(-150%); } 100% { transform: translateX(150%); } }
@keyframes stn-rec-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.stn-eq { animation: stn-eq-bounce 0.9s ease-in-out infinite; }
.stn-rec-blink { animation: stn-rec-blink 1s ease-in-out infinite; }
`

function ensureStnStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STN_STYLE_ELEMENT_ID)) return
  const element = document.createElement('style')
  element.id = STN_STYLE_ELEMENT_ID
  element.textContent = STN_KEYFRAME_CSS
  document.head.appendChild(element)
}

/* ------------------------------------------------------------------ */
/* Pure view helpers (deterministic — no Math.random, no Date.now)     */
/* ------------------------------------------------------------------ */

function faviconLetter(domain: string): string {
  return (domain.replace(/^www\./, '').charAt(0) || '?').toUpperCase()
}

/* ------------------------------------------------------------------ */
/* React Flow plumbing                                                 */
/* ------------------------------------------------------------------ */

/**
 * Hidden anchor handles — edges attach top/bottom; manual connections are
 * disabled (the canvas composes edges from the store graph, not by drawing).
 */
function StnHandles(): ReactNode {
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} className="!left-1/2 !h-1.5 !w-1.5 opacity-0" />
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="!left-1/2 !h-1.5 !w-1.5 opacity-0" />
    </>
  )
}

/** Handler props shared by every tier — built once by the root component. */
type NodeInteractions = {
  activate: (event: ReactMouseEvent) => void
  toggleStack: () => void
}

/* ------------------------------------------------------------------ */
/* Micro building blocks                                               */
/* ------------------------------------------------------------------ */

/** Neutral monochrome favicon tile — the chrome owns no hue. */
function Favicon({ node, size = 14 }: { node: SpatialTabNodeRecord; size?: number }) {
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-[4px] border border-[color:var(--border-subtle)] bg-[color:var(--glass-soft)] font-medium text-[color:var(--ink-secondary)]"
      style={{ width: size, height: size, fontSize: Math.max(7, Math.round(size * 0.5)) }}
    >
      {faviconLetter(node.domain)}
    </span>
  )
}

/**
 * Silent state grammar, live tabs: a tiny 5px accent dot beside the favicon.
 * Pulses while the simulated navigation is loading — no LIVE · 138 MB badge.
 */
function LiveDot({ pulse, className }: { pulse?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('block h-[5px] w-[5px] rounded-full bg-[color:var(--accent)]', pulse && 'animate-pulse', className)}
    />
  )
}

/** §5.3 — animated equalizer shown on audible tabs (click toggles the mock audio). */
function EqualizerBars({ className, bars = 4 }: { className?: string; bars?: number }) {
  return (
    <span aria-hidden className={cn('flex h-3 items-end gap-[2px]', className)}>
      {Array.from({ length: bars }, (_, index) => (
        <span
          key={index}
          className="stn-eq w-[2px] rounded-full bg-[color:var(--accent)]"
          style={{
            height: '100%',
            transformOrigin: 'bottom',
            animationDelay: `${index * 0.14}s`,
            animationDuration: `${0.7 + (index % 3) * 0.12}s`,
          }}
        />
      ))}
    </span>
  )
}

/** Frosted overlay chip on the preview (audible toggle, record entry). */
function PreviewChipButton({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: (event: ReactMouseEvent) => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={(event) => event.stopPropagation()}
      title={title}
      className="nodrag rounded-md border border-[color:var(--border-subtle)] p-1 text-[color:var(--ink-secondary)] backdrop-blur-md transition-colors hover:border-[color:var(--border-hover)] hover:text-[color:var(--ink-primary)]"
      style={{ backgroundColor: 'var(--bg-glass)' }}
    >
      {children}
    </button>
  )
}

function AudibleButton({ node }: { node: SpatialTabNodeRecord }) {
  const toggle = (event: ReactMouseEvent) => {
    event.stopPropagation()
    useGraphStore.getState().toggleAudible(node.uuid)
  }
  return (
    <PreviewChipButton
      title={node.isAudible ? 'Audio playing — click to mute' : 'Muted — click to play mock audio'}
      onClick={toggle}
    >
      {node.isAudible ? <EqualizerBars /> : <span className="h-3 w-[10px]" aria-hidden />}
    </PreviewChipButton>
  )
}

/** One icon of the floating hover micro-toolbar. */
function ToolButton({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: (event: ReactMouseEvent) => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={(event) => event.stopPropagation()}
      title={title}
      className="nodrag rounded-md p-1.5 text-[color:var(--ink-secondary)] transition-colors hover:bg-[color:var(--glass-soft)] hover:text-[color:var(--ink-primary)]"
    >
      {children}
    </button>
  )
}

/** The floating hover micro-toolbar shell (frosted, top-right of preview). */
function MicroToolbar({ children }: { children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -4, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.97 }}
      transition={SPRING}
      className="absolute right-1.5 top-1.5 z-20 flex items-center gap-0.5 rounded-lg border border-[color:var(--border-subtle)] p-0.5 backdrop-blur-md"
      style={{ backgroundColor: 'var(--bg-glass)', boxShadow: 'var(--shadow-pop)' }}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </motion.div>
  )
}

/* ------------------------------------------------------------------ */
/* §4.4 — sticky notes (attach to url_hash, §7.6)                      */
/* ------------------------------------------------------------------ */

function StickyNoteCard({
  note,
  isEditing,
  onEdit,
  onDismissEditor,
  className,
}: {
  note: StickyNoteRecord
  isEditing: boolean
  onEdit: (noteId: string | null) => void
  onDismissEditor: () => void
  className?: string
}) {
  const [draft, setDraft] = useState(note.text)

  const save = useCallback(() => {
    useGraphStore.getState().updateStickyNote(note.id, draft)
    onDismissEditor()
  }, [draft, note.id, onDismissEditor])

  const remove = useCallback(() => {
    useGraphStore.getState().deleteStickyNote(note.id)
    onDismissEditor()
  }, [note.id, onDismissEditor])

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      onDismissEditor()
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      save()
    }
  }

  if (isEditing) {
    return (
      <div
        className={cn('nodrag w-[200px] rounded-[10px] border border-[color:var(--border-hover)] p-2 backdrop-blur-md', className)}
        style={{ backgroundColor: 'var(--bg-elevated)', boxShadow: 'var(--shadow-card)' }}
      >
        <textarea
          value={draft}
          autoFocus
          rows={3}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={save}
          placeholder="Write on the sticky note…"
          className="nowheel w-full resize-none rounded-md bg-transparent text-[11.5px] leading-snug text-[color:var(--ink-primary)] outline-none placeholder:text-[color:var(--ink-muted)]"
        />
        <div className="mt-1.5 flex items-center justify-end gap-1">
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation()
              save()
            }}
            title="Save note"
            className="nodrag rounded-md border border-[color:var(--border-subtle)] p-1 text-[color:var(--ink-secondary)] transition-colors hover:border-[color:var(--border-hover)] hover:text-[color:var(--ink-primary)]"
          >
            <Check size={11} />
          </button>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation()
              remove()
            }}
            title="Delete note"
            className="nodrag rounded-md border border-[color:var(--border-subtle)] p-1 text-[color:var(--ink-muted)] transition-colors hover:border-[color:var(--border-hover)] hover:text-[color:var(--ink-primary)]"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onEdit(note.id)
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      title="Sticky note — click to edit inline (§4.4)"
      className={cn(
        'nodrag w-[200px] cursor-text rounded-[10px] border border-[color:var(--border-subtle)] p-2 text-left backdrop-blur-sm transition-colors hover:border-[color:var(--border-hover)]',
        className,
      )}
      style={{ backgroundColor: 'var(--bg-elevated)' }}
    >
      {note.text.trim() ? (
        <span className="line-clamp-3 text-[11.5px] leading-snug text-[color:var(--ink-primary)]">{note.text}</span>
      ) : (
        <span className="text-[11.5px] italic leading-snug text-[color:var(--ink-muted)]">Click to write…</span>
      )}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* §4.4 — voice memo pill: 12-bar waveform + real MediaRecorder audio  */
/* ------------------------------------------------------------------ */

function VoiceMemoPill({ memo }: { memo: VoiceMemo }) {
  const recorder = useVoiceRecorder()
  const profile = useMemo(() => barProfileFor(memo.id), [memo.id])
  const isPlaying = recorder.playingMemoId === memo.id
  const isPaused = isPlaying && recorder.isPlaybackPaused
  const progress = isPlaying ? recorder.playbackProgress : 0

  const toggle = (event: ReactMouseEvent) => {
    event.stopPropagation()
    if (isPlaying && !isPaused) recorder.pausePlayback()
    else if (isPlaying && isPaused) recorder.resumePlayback()
    else recorder.playMemo(memo)
  }

  const stop = (event: ReactMouseEvent) => {
    event.stopPropagation()
    recorder.stopPlayback()
  }

  const remove = (event: ReactMouseEvent) => {
    event.stopPropagation()
    useGraphStore.getState().deleteVoiceMemo(memo.id)
  }

  return (
    <div
      className="nodrag group/memo relative flex w-[236px] items-center gap-2 overflow-hidden rounded-[10px] border border-[color:var(--border-subtle)] px-2 py-1.5"
      style={{ backgroundColor: 'var(--bg-elevated)' }}
    >
      <button
        type="button"
        onClick={toggle}
        onDoubleClick={(event) => event.stopPropagation()}
        title={isPlaying ? (isPaused ? 'Resume voice memo' : 'Pause voice memo') : 'Play voice memo'}
        className="nodrag flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[color:var(--border-subtle)] text-[color:var(--ink-primary)] transition-colors hover:bg-[color:var(--glass-soft)]"
      >
        {isPlaying && !isPaused ? <Pause size={12} /> : <Play size={12} />}
      </button>
      {/* 12-bar visualizer — deterministic bar profile; animates while playing. */}
      <span className="relative flex h-5 min-w-0 flex-1 items-end gap-[2px] pb-[2px]" aria-hidden>
        {profile.map((level, index) => (
          <motion.span
            key={index}
            className="w-[3px] shrink-0 rounded-full bg-[color:var(--accent)]"
            style={{ height: `${Math.round(4 + level * 14)}px`, transformOrigin: 'bottom' }}
            animate={isPlaying && !isPaused ? { scaleY: [1, 0.35, 1] } : { scaleY: 1 }}
            transition={{ duration: 0.9, repeat: isPlaying && !isPaused ? Infinity : 0, ease: 'easeInOut', delay: index * 0.07 }}
          />
        ))}
        <motion.span
          className="absolute bottom-0 left-0 h-[2px] w-full origin-left rounded-full bg-[color:var(--accent)]"
          animate={{ scaleX: progress }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
        />
      </span>
      <span className="shrink-0 text-[10.5px] text-[color:var(--ink-secondary)]">{formatDurationMs(memo.durationMs)}</span>
      <button
        type="button"
        onClick={stop}
        title="Stop playback"
        className={cn(
          'nodrag shrink-0 rounded-md border border-[color:var(--border-subtle)] p-1 text-[color:var(--ink-muted)] transition-colors hover:text-[color:var(--ink-primary)]',
          isPlaying ? 'opacity-100' : 'opacity-0 transition-opacity group-hover/memo:opacity-100',
        )}
      >
        <Square size={9} />
      </button>
      <button
        type="button"
        onClick={remove}
        title="Delete voice memo"
        className="nodrag shrink-0 rounded-md border border-[color:var(--border-subtle)] p-1 text-[color:var(--ink-muted)] opacity-0 transition-colors group-hover/memo:opacity-100 hover:text-[color:var(--ink-primary)]"
      >
        <Trash2 size={9} />
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Voice recording panel (mounted only around a take on this card)     */
/* ------------------------------------------------------------------ */

function RecordingPanel({ nodeId, onDone }: { nodeId: string; onDone: () => void }) {
  const recorder = useVoiceRecorder()
  // `start` is a stable module-level function (the capture singleton), so it
  // is safe as an effect dependency.
  const { start } = recorder
  const [starting, setStarting] = useState(true)
  const pending = recorder.pending && recorder.pending.nodeId === nodeId ? recorder.pending : null

  useEffect(() => {
    void start(nodeId).finally(() => setStarting(false))
  }, [nodeId, start])

  useEffect(() => {
    if (!starting && !recorder.isRecording && !pending) onDone()
  }, [starting, recorder.isRecording, pending, onDone])

  if (pending) {
    return (
      <div
        className="nodrag flex items-center gap-2 rounded-[10px] border border-[color:var(--border-subtle)] px-2 py-1.5"
        style={{ backgroundColor: 'var(--bg-elevated)' }}
      >
        <span className="text-[10.5px] text-[color:var(--ink-secondary)]">{formatDurationMs(pending.durationMs)} take</span>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            recorder.commitPending()
            onDone()
          }}
          title="Save voice memo to this node"
          className="nodrag rounded-md border border-[color:var(--border-subtle)] p-1 text-[color:var(--ink-primary)] transition-colors hover:bg-[color:var(--glass-soft)]"
        >
          <Check size={11} />
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            recorder.discardPending()
            onDone()
          }}
          title="Discard the take"
          className="nodrag rounded-md border border-[color:var(--border-subtle)] p-1 text-[color:var(--ink-muted)] transition-colors hover:text-[color:var(--ink-primary)]"
        >
          <Trash2 size={11} />
        </button>
      </div>
    )
  }

  if (recorder.error && !recorder.isRecording) {
    return (
      <div
        className="nodrag flex max-w-[236px] items-center gap-2 rounded-[10px] border border-[color:var(--border-subtle)] px-2 py-1.5"
        style={{ backgroundColor: 'var(--bg-elevated)' }}
      >
        <TriangleAlert size={11} className="shrink-0 text-[color:var(--ink-secondary)]" />
        <span className="truncate text-[10.5px] text-[color:var(--ink-secondary)]">{recorder.error}</span>
        <button
          type="button"
          onClick={onDone}
          title="Close"
          className="nodrag rounded-md border border-[color:var(--border-subtle)] p-1 text-[color:var(--ink-muted)] transition-colors hover:text-[color:var(--ink-primary)]"
        >
          <X size={10} />
        </button>
      </div>
    )
  }

  if (recorder.isRecording) {
    return (
      <div
        className="nodrag flex w-[236px] items-center gap-2 rounded-[10px] border border-[color:var(--border-subtle)] px-2 py-1.5"
        style={{ backgroundColor: 'var(--bg-elevated)' }}
      >
        <span className="stn-rec-blink h-[5px] w-[5px] shrink-0 rounded-full bg-[color:var(--accent)]" aria-hidden />
        <span className="shrink-0 text-[10.5px] text-[color:var(--ink-secondary)]">{formatDurationMs(recorder.elapsedMs)}</span>
        <span className="flex h-5 min-w-0 flex-1 items-end gap-[2px]" aria-hidden>
          {recorder.liveLevels.slice(0, LIVE_LEVEL_BARS).map((level, index) => (
            <span
              key={index}
              className="w-[3px] shrink-0 rounded-full bg-[color:var(--accent)]"
              style={{ height: `${Math.max(2, Math.round(level * 18))}px` }}
            />
          ))}
        </span>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            recorder.stop()
          }}
          title="Stop recording (keeps the take)"
          className="nodrag rounded-md border border-[color:var(--border-subtle)] p-1 text-[color:var(--ink-primary)] transition-colors hover:bg-[color:var(--glass-soft)]"
        >
          <Square size={10} />
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            recorder.cancel()
            onDone()
          }}
          title="Cancel recording"
          className="nodrag rounded-md border border-[color:var(--border-subtle)] p-1 text-[color:var(--ink-muted)] transition-colors hover:text-[color:var(--ink-primary)]"
        >
          <X size={10} />
        </button>
      </div>
    )
  }

  return null
}

/* ------------------------------------------------------------------ */
/* §7.5 — cached-text modal (markdown excerpt of a dead link)          */
/* ------------------------------------------------------------------ */

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  return text.split(/(`[^`]+`)/g).map((part, index) => {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      return (
        <code
          key={`${keyPrefix}-${index}`}
          className="rounded bg-[color:var(--glass-soft)] px-1 py-0.5 font-mono text-[11px] text-[color:var(--ink-primary)]"
        >
          {part.slice(1, -1)}
        </code>
      )
    }
    return <span key={`${keyPrefix}-${index}`}>{part}</span>
  })
}

function renderExcerptMarkdown(text: string): ReactNode[] {
  return text.split('\n').map((line, index) => {
    const key = `excerpt-${index}`
    const trimmed = line.trim()
    if (trimmed === '') return <div key={key} className="h-2" />
    if (trimmed === '---') return <hr key={key} className="my-3 border-[color:var(--border-subtle)]" />
    if (line.startsWith('> ')) {
      return (
        <blockquote key={key} className="border-l-2 border-[color:var(--border-hover)] pl-3 text-[12px] italic text-[color:var(--ink-secondary)]">
          {renderInlineMarkdown(line.slice(2), key)}
        </blockquote>
      )
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      return (
        <h3
          key={key}
          className={cn('font-semibold text-[color:var(--ink-primary)]', heading[1].length === 1 ? 'text-[15px]' : 'text-[13px]')}
        >
          {heading[2]}
        </h3>
      )
    }
    const italicLine = /^\*\((.+)\)\*$/.exec(trimmed)
    if (italicLine) {
      return (
        <p key={key} className="text-[11px] italic text-[color:var(--ink-muted)]">
          {italicLine[1]}
        </p>
      )
    }
    return (
      <p key={key} className="text-[13px] leading-relaxed text-[color:var(--ink-secondary)]">
        {renderInlineMarkdown(line, key)}
      </p>
    )
  })
}

function ExcerptModal({ node, onClose }: { node: SpatialTabNodeRecord; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    // Capture phase: the modal's Esc must win over the app's layered dismissal (§10).
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-void/65 p-6 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-label={`Cached text — ${node.title}`}
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[72vh] w-[560px] max-w-full flex-col overflow-hidden rounded-xl border border-[color:var(--border-subtle)]"
        style={{ backgroundColor: 'var(--bg-elevated)', boxShadow: 'var(--shadow-pop)' }}
      >
        <div className="flex items-center gap-2 border-b border-[color:var(--border-subtle)] px-4 py-3">
          <FileText size={14} className="shrink-0 text-[color:var(--ink-secondary)]" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-[color:var(--ink-primary)]">{node.title}</div>
            {/* A real URL — JetBrains Mono is reserved for URLs and <kbd> hints. */}
            <div className="truncate font-mono text-[10px] text-[color:var(--ink-muted)]">{node.url}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close cached text"
            className="rounded-md border border-[color:var(--border-subtle)] p-1.5 text-[color:var(--ink-secondary)] transition-colors hover:border-[color:var(--border-hover)] hover:text-[color:var(--ink-primary)]"
          >
            <X size={13} />
          </button>
        </div>
        <div className="overflow-y-auto px-4 py-4">{renderExcerptMarkdown(node.excerpt ?? '')}</div>
        <div className="border-t border-[color:var(--border-subtle)] px-4 py-2 text-[10px] text-[color:var(--ink-muted)]">
          Cached snapshot · {node.domain}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ------------------------------------------------------------------ */
/* MACRO tier — pure beacons (§4.1, zoom < 0.35)                       */
/*                                                                     */
/* The beacon shell inverse-scales with viewport zoom through the      */
/* --stn-beacon-scale custom property set on the canvas root, so the   */
/* dot keeps a ~constant on-screen footprint across the whole macro    */
/* band (audit round 2 §1.7 — sub-pixel specks at 30% zoom).           */
/* ------------------------------------------------------------------ */

function MacroBeacon({
  node,
  regionName,
  isActive,
  childCount,
  isStackCollapsed,
  interactions,
}: {
  node: SpatialTabNodeRecord
  regionName: string | null
  isActive: boolean
  childCount: number
  isStackCollapsed: boolean
  interactions: NodeInteractions
}) {
  const now = Date.now()
  const cold = isColdArchive(node, now)
  const isGhost = node.nodeType === 'ghost-echo'
  const isHub = node.nodeType === 'hub'
  const showDeck = isStackCollapsed && childCount > 0
  // Region-cluster title carriers at macro zoom: pinned anchors (§6).
  const carrier = node.isPinned && !isGhost
  const showLabel = carrier || isActive || showDeck

  return (
    <div
      className="nodrag relative flex h-6 w-6 items-center justify-center"
      style={{ transform: 'scale(var(--stn-beacon-scale, 1))' }}
      onClick={interactions.activate}
      onDoubleClick={(event) => {
        event.stopPropagation()
        interactions.toggleStack()
      }}
    >
      <span
        className={cn(
          'block h-[22px] w-[22px] rounded-full border',
          isGhost
            ? 'border-[color:var(--border-hover)] bg-[color:var(--bg-glass)] opacity-55'
            : isHub
              ? 'border-[color:var(--border-subtle)] bg-[color:var(--bg-elevated)]'
              : node.ramState === 'live'
                ? 'border-[color:var(--border-active)] bg-[color:var(--accent)]'
                : 'border-[color:var(--border-hover)] bg-[color:var(--bg-elevated)]',
          cold && 'opacity-[0.58]',
        )}
        style={isActive && !isGhost ? { boxShadow: 'var(--shadow-card)' } : undefined}
      />
      {node.isPinned && (
        <span
          aria-hidden
          className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-[color:var(--bg-canvas)] bg-[color:var(--accent)]"
        />
      )}
      {showDeck && (
        <span
          className="absolute -bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-[color:var(--border-subtle)] px-1.5 py-px text-[10px] text-[color:var(--ink-secondary)] backdrop-blur-md"
          style={{ backgroundColor: 'var(--bg-glass)' }}
        >
          +{childCount}
        </span>
      )}
      {showLabel && (
        <span
          className={cn(
            'pointer-events-none absolute left-1/2 top-7 max-w-[240px] -translate-x-1/2 truncate whitespace-nowrap text-center text-[12px] font-semibold text-[color:var(--ink-primary)]',
            carrier && 'drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]',
          )}
        >
          {carrier ? (regionName ?? node.title) : node.title}
        </span>
      )}
      <StnHandles />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* COMPACT tier — sleek 180×44 pills (§4.2, 0.35 ≤ zoom < 0.65)        */
/* ------------------------------------------------------------------ */

function CompactPill({
  node,
  isActive,
  noteCount,
  hasVoiceMemo,
  childCount,
  isStackCollapsed,
  interactions,
}: {
  node: SpatialTabNodeRecord
  isActive: boolean
  noteCount: number
  hasVoiceMemo: boolean
  childCount: number
  isStackCollapsed: boolean
  interactions: NodeInteractions
}) {
  const now = Date.now()
  const cold = isColdArchive(node, now)
  const isGhost = node.nodeType === 'ghost-echo'
  const showDeck = isStackCollapsed && childCount > 0

  return (
    <div
      className={cn(
        'nodrag relative flex h-[44px] w-[180px] cursor-pointer items-center gap-2 rounded-[10px] border px-2.5',
        isGhost
          ? 'border-[rgba(255,255,255,0.12)] bg-[color:var(--bg-glass)] opacity-55 backdrop-blur-md'
          : cn(
              'bg-[color:var(--bg-card)]',
              isActive
                ? 'border-[color:var(--border-active)]'
                : 'border-[color:var(--border-subtle)] hover:border-[color:var(--border-hover)]',
            ),
        cold && 'opacity-[0.58]',
      )}
      style={isActive && !isGhost ? { boxShadow: 'var(--shadow-card)' } : undefined}
      onClick={interactions.activate}
      onDoubleClick={(event) => {
        event.stopPropagation()
        interactions.toggleStack()
      }}
      title={`${node.title} — click to ${node.ramState === 'hibernated' ? 'wake' : 'activate'}`}
    >
      <span className="relative shrink-0">
        <Favicon node={node} size={14} />
        {node.ramState === 'live' && (
          <LiveDot pulse={node.isLoading} className="absolute -bottom-[2px] -right-[2px] ring-2 ring-[color:var(--bg-card)]" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[color:var(--ink-primary)]">{node.title}</span>
      <span className="flex shrink-0 items-center gap-1.5">
        {node.isAudible && <EqualizerBars bars={3} className="h-2.5" />}
        {noteCount > 0 && <StickyNote size={11} className="text-[color:var(--ink-muted)]" />}
        {hasVoiceMemo && <span className="h-1.5 w-1.5 rounded-full border border-[color:var(--ink-muted)]" title="Has voice memo" />}
        {node.isPinned && <Pin size={10} className="text-[color:var(--ink-secondary)]" />}
        {showDeck && (
          <span className="rounded-full border border-[color:var(--border-subtle)] px-1 text-[9.5px] text-[color:var(--ink-secondary)]">
            +{childCount}
          </span>
        )}
      </span>
      <StnHandles />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* §7.1 — hub super-node: small neutral router chip (rich tier)        */
/* ------------------------------------------------------------------ */

function HubRouterChip({
  node,
  isActive,
  childCount,
  isStackCollapsed,
  interactions,
}: {
  node: SpatialTabNodeRecord
  isActive: boolean
  childCount: number
  isStackCollapsed: boolean
  interactions: NodeInteractions
}) {
  const showDeck = isStackCollapsed && childCount > 0
  return (
    <div
      className={cn(
        'nodrag relative flex w-[220px] cursor-pointer items-center gap-2.5 rounded-[10px] border bg-[color:var(--bg-card)] px-2.5 py-2',
        isActive ? 'border-[color:var(--border-active)]' : 'border-[color:var(--border-subtle)] hover:border-[color:var(--border-hover)]',
      )}
      style={isActive ? { boxShadow: 'var(--shadow-card)' } : undefined}
      onClick={interactions.activate}
      onDoubleClick={(event) => {
        event.stopPropagation()
        interactions.toggleStack()
      }}
      title="Ephemeral search-hub router — click to route"
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--glass-soft)] text-[color:var(--ink-secondary)]">
        <Network size={13} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11.5px] text-[color:var(--ink-secondary)]">{node.domain}</span>
        {node.searchQuery && (
          <span className="mt-0.5 flex items-center gap-1">
            <Search size={9} className="shrink-0 text-[color:var(--ink-muted)]" />
            <span className="truncate text-[10.5px] text-[color:var(--ink-muted)]">{node.searchQuery}</span>
          </span>
        )}
      </span>
      {showDeck && (
        <span className="shrink-0 rounded-full border border-[color:var(--border-subtle)] px-1.5 py-px text-[10px] text-[color:var(--ink-secondary)]">
          +{childCount}
        </span>
      )}
      <StnHandles />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* §4.3 — ghost echo node (rich tier): a quiet translucent memory      */
/* ------------------------------------------------------------------ */

function GhostEchoCard({ node, interactions }: { node: SpatialTabNodeRecord; interactions: NodeInteractions }) {
  const [hovered, setHovered] = useState(false)
  const dismiss = (event: ReactMouseEvent) => {
    event.stopPropagation()
    useGraphStore.getState().dismissGhostEcho(node.uuid)
  }
  const open = (event: ReactMouseEvent) => {
    event.stopPropagation()
    useGraphStore.getState().wakeGhostEcho(node.uuid)
  }

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: hovered ? 0.8 : 0.55, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={SPRING}
      className="nodrag relative w-[260px] cursor-pointer rounded-[10px] border backdrop-blur-xl"
      style={{ borderColor: 'rgba(255, 255, 255, 0.12)', backgroundColor: 'var(--bg-glass)' }}
      onClick={interactions.activate}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title="Related earlier — click to open the predicted tab"
    >
      <div className="px-3.5 py-3">
        <div className="line-clamp-2 text-[12.5px] font-medium leading-snug text-[color:var(--ink-primary)]">{node.title}</div>
        <div className="mt-1 truncate text-[11px] text-[color:var(--ink-muted)]">{node.domain}</div>
        <div className="mt-2.5 flex items-center gap-1.5 text-[11px] text-[color:var(--ink-muted)]">
          <span aria-hidden className="block h-[5px] w-[5px] rounded-full border border-[color:var(--ink-muted)]" />
          Related earlier
        </div>
      </div>
      <AnimatePresence>
        {hovered && (
          <MicroToolbar>
            <ToolButton onClick={open} title="Open — wake the predicted tab here">
              <ExternalLink size={13} />
            </ToolButton>
            <ToolButton onClick={dismiss} title="Dismiss — suppresses this URL for the session">
              <X size={12} />
            </ToolButton>
          </MicroToolbar>
        )}
      </AnimatePresence>
      <StnHandles />
    </motion.div>
  )
}

/* ------------------------------------------------------------------ */
/* RICH tier — the 260px editorial reference card (§4.3, zoom ≥ 0.65)  */
/* ------------------------------------------------------------------ */

function RichCard({
  node,
  isActive,
  childCount,
  isStackCollapsed,
  selected,
  dragging,
  interactions,
}: {
  node: SpatialTabNodeRecord
  isActive: boolean
  childCount: number
  isStackCollapsed: boolean
  selected: boolean
  dragging: boolean
  interactions: NodeInteractions
}) {
  // Rich-tier-only store slices: notes for inline editing (§4.4/§7.6) and the
  // real recorded memos. useShallow keeps these stable across store updates.
  const notes = useGraphStore(useShallow((state) => selectNotesForNode(state, node.uuid)))
  const memos = useGraphStore(useShallow((state) => selectMemosForNode(state, node.uuid)))
  const storeRecordingNodeId = useGraphStore((state) => state.recordingNodeId)

  const [hovered, setHovered] = useState(false)
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [allNotesOpen, setAllNotesOpen] = useState(false)
  const [filmstripOpen, setFilmstripOpen] = useState(false)
  const [excerptOpen, setExcerptOpen] = useState(false)
  const [recordingOpen, setRecordingOpen] = useState(false)

  const now = Date.now()
  const cold = isColdArchive(node, now)
  const isLive = node.ramState === 'live'
  const isHibernated = node.ramState === 'hibernated'
  const showDeck = isStackCollapsed && childCount > 0
  const recordingHere = storeRecordingNodeId === node.uuid
  const elevated = isActive || selected

  const spec = useMemo(() => previewSpecForNode(node), [node])

  const dismissEditor = useCallback(() => setEditingNoteId(null), [])

  const addNote = (event: ReactMouseEvent) => {
    event.stopPropagation()
    const noteId = useGraphStore.getState().addStickyNote(node.urlHash)
    setEditingNoteId(noteId)
  }

  const openViewport = (event: ReactMouseEvent) => {
    event.stopPropagation()
    useGraphStore.getState().openNodeInViewport(node.uuid)
  }

  const hibernate = (event: ReactMouseEvent) => {
    event.stopPropagation()
    useGraphStore.getState().hibernateNode(node.uuid)
  }

  const togglePin = (event: ReactMouseEvent) => {
    event.stopPropagation()
    useGraphStore.getState().pinNode(node.uuid, !node.isPinned)
  }

  const startRecording = (event: ReactMouseEvent) => {
    event.stopPropagation()
    setRecordingOpen(true)
  }

  const closeRecording = useCallback(() => setRecordingOpen(false), [])

  const openSubPage = (sub: { url: string; title: string }) => {
    const state = useGraphStore.getState()
    if (!isActive) state.activateNode(node.uuid)
    state.navigateActiveNode(sub.url, sub.title)
  }

  return (
    <div className="relative w-[260px]">
      {/* ---------------- the card itself: preview + 36px footer ---------------- */}
      <div
        className={cn(
          'nodrag relative w-[260px] cursor-pointer rounded-[10px] border bg-[color:var(--bg-card)] transition-colors duration-150',
          elevated
            ? 'border-[color:var(--border-active)]'
            : 'border-[color:var(--border-subtle)] hover:border-[color:var(--border-hover)]',
          cold && 'opacity-[0.58]',
        )}
        style={
          elevated
            ? { boxShadow: dragging ? 'var(--shadow-pop)' : 'var(--shadow-card)' }
            : dragging
              ? { boxShadow: 'var(--shadow-pop)' }
              : undefined
        }
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onDoubleClick={(event) => {
          event.stopPropagation()
          interactions.toggleStack()
        }}
      >
        {/* Edge-to-edge 16:10 preview — the deterministic PreviewArt render */}
        <div className="relative h-[162px] overflow-hidden rounded-t-[10px] border-b border-[color:var(--border-subtle)]">
          {node.noCapture ? (
            /* §7.4 — private/sensitive: frosted placeholder, never a capture */
            <div
              className="absolute inset-0 flex items-center justify-center bg-[color:var(--bg-elevated)]"
              title="Private — capture suppressed"
            >
              <CameraOff size={20} className="text-[color:var(--ink-muted)]" />
            </div>
          ) : (
            <PreviewArt spec={spec} className={cn('absolute inset-0', cold && 'saturate-[0.72]')} />
          )}

          {/* loading — a quiet shimmer sweep; the footer dot pulses (silent) */}
          {node.isLoading && (
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
              <div
                className="absolute inset-y-0 w-1/3 bg-[color:var(--glass-soft)] blur-md"
                style={{ animation: 'stn-shimmer-slide 1.2s ease-in-out infinite' }}
              />
            </div>
          )}

          {/* pinned — small corner pin glyph while pinned, faint while hovered */}
          {(node.isPinned || hovered) && (
            <span
              aria-hidden
              title={node.isPinned ? 'Pinned anchor — (fx, fy) locked, physics never drifts it' : undefined}
              className={cn(
                'absolute left-1.5 top-1.5 z-10 rounded-md p-1 backdrop-blur-md',
                node.isPinned ? 'text-[color:var(--ink-primary)]' : 'text-[color:var(--ink-muted)] opacity-0 transition-opacity duration-150',
                hovered && 'opacity-100',
              )}
              style={{ backgroundColor: 'var(--bg-glass)' }}
            >
              <Pin size={10} strokeWidth={2.25} />
            </span>
          )}

          {/* §4.5 — collapsed stack deck badge, quiet +N (no "+N TABS" text) */}
          {showDeck && (
            <span
              className="absolute bottom-1.5 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-[color:var(--border-subtle)] px-2 py-0.5 text-[10px] text-[color:var(--ink-secondary)] backdrop-blur-md"
              style={{ backgroundColor: 'var(--bg-glass)' }}
              title={`${childCount} tabs collapsed into this stack — double-click to fan out`}
            >
              <Layers size={9} />
              +{childCount}
            </span>
          )}

          {/* bottom-left preview controls: audible toggle (persistent) + record (hover) */}
          {(node.isAudible || (hovered && !recordingHere && !recordingOpen)) && (
            <div className="absolute bottom-1.5 left-1.5 z-10 flex items-center gap-1">
              {node.isAudible && <AudibleButton node={node} />}
              {hovered && !recordingHere && !recordingOpen && (
                <PreviewChipButton title="Record a voice memo on this node" onClick={startRecording}>
                  <Mic size={12} />
                </PreviewChipButton>
              )}
            </div>
          )}

          {/* §7.5 — cached-text affordance on hibernated dead links (icon only) */}
          {isHibernated && node.excerpt && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                setExcerptOpen(true)
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              title="Open cached text snapshot"
              className="nodrag absolute bottom-1.5 right-1.5 z-10 rounded-md border border-[color:var(--border-subtle)] p-1 text-[color:var(--ink-muted)] opacity-70 backdrop-blur-md transition-colors hover:border-[color:var(--border-hover)] hover:text-[color:var(--ink-primary)] hover:opacity-100"
              style={{ backgroundColor: 'var(--bg-glass)' }}
            >
              <FileText size={12} />
            </button>
          )}

          {/* hover micro-toolbar: Open · Pin · Note · Sleep (live tabs only) */}
          <AnimatePresence>
            {hovered && (
              <MicroToolbar>
                <ToolButton onClick={openViewport} title="Open — focus this tab in the reading viewport">
                  <ExternalLink size={13} />
                </ToolButton>
                <ToolButton
                  onClick={togglePin}
                  title={node.isPinned ? 'Unpin anchor — release (fx, fy)' : 'Pin anchor — lock (fx, fy) so physics never drifts it'}
                >
                  <Pin size={13} fill={node.isPinned ? 'currentColor' : 'none'} />
                </ToolButton>
                <ToolButton onClick={addNote} title="Note — attach a sticky note to this URL (shared across duplicates)">
                  <StickyNote size={13} />
                </ToolButton>
                {isLive && (
                  <ToolButton onClick={hibernate} title="Sleep — quiet this tab to 0 MB">
                    <Moon size={13} />
                  </ToolButton>
                )}
              </MicroToolbar>
            )}
          </AnimatePresence>
        </div>

        {/* Clean 36px footer: 14px favicon + live dot · 12.5px title · 11px domain */}
        <div className="flex h-9 items-center gap-2 px-3">
          <span className="relative shrink-0">
            <Favicon node={node} size={14} />
            {isLive && (
              <LiveDot pulse={node.isLoading} className="absolute -bottom-[2px] -right-[2px] ring-2 ring-[color:var(--bg-card)]" />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[color:var(--ink-primary)]">{node.title}</span>
          {node.viaAuth && (
            <span title="Collapsed from a sign-in / payment redirect chain (§7.2)">
              <Lock size={10} className="shrink-0 text-[color:var(--ink-muted)]" />
            </span>
          )}
          <span className="max-w-[84px] shrink-0 truncate text-[11px] text-[color:var(--ink-muted)]">{node.domain}</span>
        </div>
      </div>

      {/* ---------------- attachments under the card (behavior intact) ---------------- */}
      <div className="mt-1.5 flex flex-col items-center gap-1.5">
        {/* §7.1 — subtle search-query trail on hub destination nodes */}
        {node.searchQuery && node.nodeType !== 'hub' && (
          <div className="flex w-full items-center gap-1.5 px-1" title={`Reached via search: ${node.searchQuery}`}>
            <Search size={10} className="shrink-0 text-[color:var(--ink-muted)]" />
            <span className="truncate text-[11px] text-[color:var(--ink-muted)]">{node.searchQuery}</span>
          </div>
        )}

        {(recordingHere || recordingOpen) && <RecordingPanel nodeId={node.uuid} onDone={closeRecording} />}

        {memos.map((memo) => (
          <VoiceMemoPill key={memo.id} memo={memo} />
        ))}

        {/* §7.3 — SPA pushState trail as an expandable filmstrip */}
        {node.subPages.length > 0 && (
          <div className="nodrag w-full">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                setFilmstripOpen((open) => !open)
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              title="Expand the SPA navigation trail"
              className="nodrag inline-flex items-center gap-1.5 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] px-2 py-1 text-[11px] text-[color:var(--ink-secondary)] transition-colors hover:border-[color:var(--border-hover)] hover:text-[color:var(--ink-primary)]"
            >
              <Film size={11} />
              {node.subPages.length} {node.subPages.length === 1 ? 'page' : 'pages'}
              {filmstripOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            </button>
            <AnimatePresence initial={false}>
              {filmstripOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={SPRING}
                  className="overflow-hidden"
                >
                  <div className="mt-1 flex flex-col gap-1">
                    {node.subPages.map((sub, index) => (
                      <button
                        key={sub.url}
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          openSubPage(sub)
                        }}
                        onDoubleClick={(event) => event.stopPropagation()}
                        title={`Navigate this node to ${sub.url}`}
                        className="nodrag flex w-full items-center gap-2 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] px-2 py-1.5 text-left transition-colors hover:border-[color:var(--border-hover)]"
                      >
                        <span className="shrink-0 text-[10px] text-[color:var(--ink-muted)]">{String(index + 1).padStart(2, '0')}</span>
                        <span className="min-w-0 flex-1 truncate text-[11.5px] text-[color:var(--ink-secondary)]">{sub.title}</span>
                        <ArrowUpRight size={11} className="shrink-0 text-[color:var(--ink-muted)]" />
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* §4.4 — sticky notes attach under the card, tucked toward the bottom-right */}
        {notes.length > 0 && (
          <div className="nodrag flex flex-col items-end gap-1.5">
            {(allNotesOpen ? notes : notes.slice(0, 1)).map((note, index) => (
              <StickyNoteCard
                key={note.id}
                note={note}
                isEditing={editingNoteId === note.id}
                onEdit={setEditingNoteId}
                onDismissEditor={dismissEditor}
                className={
                  allNotesOpen
                    ? index % 2 === 1
                      ? 'rotate-[0.8deg]'
                      : '-rotate-[0.8deg]'
                    : '-mt-0.5 rotate-[-1.2deg]'
                }
              />
            ))}
            {notes.length > 1 && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  setAllNotesOpen((open) => !open)
                  setEditingNoteId(null)
                }}
                onDoubleClick={(event) => event.stopPropagation()}
                title={
                  allNotesOpen
                    ? 'Collapse notes back into the tucked card'
                    : `Show all ${notes.length} notes (shared by duplicate URLs of this page)`
                }
                className="nodrag inline-flex items-center gap-1 rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] px-2 py-0.5 text-[10px] text-[color:var(--ink-secondary)] transition-colors hover:border-[color:var(--border-hover)] hover:text-[color:var(--ink-primary)]"
              >
                <StickyNote size={9} />
                {allNotesOpen ? 'Collapse notes' : `${notes.length} notes`}
              </button>
            )}
          </div>
        )}
      </div>

      <StnHandles />
      {excerptOpen && <ExcerptModal node={node} onClose={() => setExcerptOpen(false)} />}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Root — dispatch by node kind + LOD tier                             */
/* ------------------------------------------------------------------ */

function SpatialTabNodeInner(props: SpatialTabNodeProps) {
  ensureStnStyles()
  // §4 semantic-zoom tier flows through context (not node data) so a tier
  // crossing never rebuilds the React Flow node store — see canvasLodContext.
  const { lod } = useContext(CanvasLodContext)
  const { node, regionName, isActive, childCount, isStackCollapsed } = props.data

  // §6 drag-vs-click guard: a click that follows >4px pointer travel is a
  // drag-release (drag-to-anchor §6) and must not activate the tab.
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null)
  const handlePointerDown = useCallback((event: ReactPointerEvent) => {
    pointerDownRef.current = { x: event.clientX, y: event.clientY }
  }, [])

  const activate = useCallback(
    (event: ReactMouseEvent) => {
      const down = pointerDownRef.current
      if (down && (Math.abs(event.clientX - down.x) > 4 || Math.abs(event.clientY - down.y) > 4)) return
      useGraphStore.getState().activateNode(node.uuid)
    },
    [node.uuid],
  )

  const toggleStack = useCallback(() => {
    if (childCount <= 0) return
    useGraphStore.getState().toggleStack(node.uuid)
  }, [childCount, node.uuid])

  const interactions: NodeInteractions = useMemo(() => ({ activate, toggleStack }), [activate, toggleStack])

  // Ghost Echo cards exist only at rich zoom; at macro/compact they degrade
  // into the same pure beacons/pills as every other node (§4.1).
  if (node.nodeType === 'ghost-echo' && lod === 'rich') {
    return (
      <div onPointerDown={handlePointerDown} className="w-fit">
        <GhostEchoCard node={node} interactions={interactions} />
      </div>
    )
  }
  if (node.nodeType === 'hub' && lod === 'rich') {
    return (
      <div onPointerDown={handlePointerDown} className="w-fit">
        <HubRouterChip
          node={node}
          isActive={isActive}
          childCount={childCount}
          isStackCollapsed={isStackCollapsed}
          interactions={interactions}
        />
      </div>
    )
  }
  if (lod === 'macro') {
    return (
      <div onPointerDown={handlePointerDown} className="w-fit">
        <MacroBeacon
          node={node}
          regionName={regionName}
          isActive={isActive}
          childCount={childCount}
          isStackCollapsed={isStackCollapsed}
          interactions={interactions}
        />
      </div>
    )
  }
  if (lod === 'compact') {
    return (
      <div onPointerDown={handlePointerDown} className="w-fit">
        <CompactPill
          node={node}
          isActive={isActive}
          noteCount={props.data.noteCount}
          hasVoiceMemo={props.data.hasVoiceMemo}
          childCount={childCount}
          isStackCollapsed={isStackCollapsed}
          interactions={interactions}
        />
      </div>
    )
  }
  return (
    <div onPointerDown={handlePointerDown} className="w-fit">
      <RichCard
        node={node}
        isActive={isActive}
        childCount={childCount}
        isStackCollapsed={isStackCollapsed}
        selected={props.selected}
        dragging={props.dragging}
        interactions={interactions}
      />
    </div>
  )
}

/**
 * Custom comparator: the canvas rebuilds `data` objects each render but reuses
 * the persisted record references, so compare the record by identity and every
 * scalar flag explicitly. Keeps 600 stress nodes from re-rendering on pan/zoom.
 */
function areSpatialTabNodePropsEqual(prev: SpatialTabNodeProps, next: SpatialTabNodeProps): boolean {
  if (prev.id !== next.id) return false
  if (prev.selected !== next.selected) return false
  if (prev.dragging !== next.dragging) return false
  if (prev.zIndex !== next.zIndex) return false
  const a = prev.data
  const b = next.data
  if (a.node !== b.node) return false
  // The §4 LOD tier is delivered through CanvasLodContext (context updates
  // bypass this comparator), so it is not part of the data comparison.
  return (
    a.regionName === b.regionName &&
    a.regionColor === b.regionColor &&
    a.isActive === b.isActive &&
    a.isWorkbench === b.isWorkbench &&
    a.noteCount === b.noteCount &&
    a.hasVoiceMemo === b.hasVoiceMemo &&
    a.childCount === b.childCount &&
    a.isStackCollapsed === b.isStackCollapsed
  )
}

export const SpatialTabNode = memo(SpatialTabNodeInner, areSpatialTabNodePropsEqual)
export default SpatialTabNode
