/**
 * app/src/components/canvas/nodes/SpatialTabNode.tsx — the spatial tab card
 * (SPEC §4: 3 semantic zoom levels × 6 visual states, §6 founder addenda,
 * §7 edge cases).
 *
 * Rendered by @xyflow/react as the custom node type `spatialTab`. The record,
 * LOD and all context flags flow in through `SpatialTabNodeData` (built per
 * render by SpatialCanvas); the component only subscribes to the store for
 * the slices it genuinely needs to own interactions:
 *   - `selectNotesForNode` / `selectMemosForNode` — rich tier only (inline
 *     sticky-note editing + real MediaRecorder playback)
 *   - `recordingNodeId` — to surface the recording panel on this card
 *   - every mutation goes through `useGraphStore.getState()` in handlers
 *
 * LOD tiers (§4):
 *   macro   — ~24px pure beacons + region-cluster titles, heavy DOM unmounted
 *   compact — sleek 180×44 pill: favicon + truncated title + micro-dots + pin
 *   rich    — full 260px card: 16:9 thumbnail (146px), badges, hover actions
 *
 * States (§4): active/live glow + pulsing dot + mono LIVE·RAM badge,
 * hibernated desaturation + SLEEP·0 MB + 14-day Cold Archive decay,
 * ghost-echo dashed violet with % MATCH + Wake Here / Dismiss, annotated
 * sticky-note glass card + voice-memo waveform pill, collapsed macro-stack
 * layered deck with +N TABS, pinned anchor vs orbiting satellite glyphs.
 * Edge cases (§7): hub router chips, via-auth tags, SPA subPages filmstrip,
 * noCapture blur-glass placeholders, cached-text chip + excerpt modal,
 * search-query pills.
 *
 * Motion: framer-motion springs stiffness 380 / damping 30 everywhere except
 * the macro tier, which stays motion-free for the 600-node stress run.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  FileText,
  Film,
  Ghost,
  Layers,
  Lock,
  Mic,
  Network,
  Orbit,
  Pause,
  Pin,
  PinOff,
  Play,
  Plus,
  ScanEye,
  Search,
  Snowflake,
  Square,
  StickyNote,
  Trash2,
  X,
  Zap,
} from 'lucide-react'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { fnv1a32 } from '../../../lib/embed'
import { barProfileFor, LIVE_LEVEL_BARS, useVoiceRecorder } from '../../../hooks/useVoiceRecorder'
import { selectMemosForNode, selectNotesForNode, useGraphStore } from '../../../store/useGraphStore'
import { daysSince, formatDurationMs, formatRamMb, isColdArchive } from '../../../lib/types'
import type {
  SpatialTabNodeProps,
  SpatialTabNodeRecord,
  StickyNote as StickyNoteRecord,
  VoiceMemo,
} from '../../../lib/types'
import { useShallow } from 'zustand/react/shallow'

/* ------------------------------------------------------------------ */
/* Shared motion + style plumbing                                      */
/* ------------------------------------------------------------------ */

/** SPEC §2 motion language — one spring for the whole node card. */
const SPRING: Transition = { type: 'spring', stiffness: 380, damping: 30 }

const cn = (...inputs: Parameters<typeof clsx>) => twMerge(clsx(...inputs))

const STN_STYLE_ELEMENT_ID = 'stn-node-keyframes'

/**
 * Keyframes for the cheap CSS loops (equalizer bars, ghost breathing glow,
 * loading shimmer, record blink). Injected once per document instead of a
 * <style> tag per node — 600 stress nodes must not each ship their own copy.
 */
const STN_KEYFRAME_CSS = `
@keyframes stn-eq-bounce { 0%, 100% { transform: scaleY(0.3); } 50% { transform: scaleY(1); } }
@keyframes stn-ghost-breathe { 0%, 100% { box-shadow: 0 0 14px rgba(167, 139, 250, 0.16); } 50% { box-shadow: 0 0 28px rgba(167, 139, 250, 0.4); } }
@keyframes stn-shimmer-slide { 0% { transform: translateX(-150%); } 100% { transform: translateX(150%); } }
@keyframes stn-rec-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.stn-eq { animation: stn-eq-bounce 0.9s ease-in-out infinite; }
.stn-ghost-breathe { animation: stn-ghost-breathe 2.6s ease-in-out infinite; }
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

/** §2 palette accents keyed by node state. */
const ACCENT_LIVE = '#34D399'
const ACCENT_GHOST = '#A78BFA'
const ACCENT_HUB = '#94A3B8'
const ACCENT_SLEEP = '#64748B'

function hashHue(seed: string): number {
  return fnv1a32(seed) % 360
}

function faviconLetter(domain: string): string {
  return (domain.replace(/^www\./, '').charAt(0) || '?').toUpperCase()
}

function accentFor(node: SpatialTabNodeRecord): string {
  if (node.nodeType === 'ghost-echo') return ACCENT_GHOST
  if (node.nodeType === 'hub') return ACCENT_HUB
  return node.ramState === 'live' ? ACCENT_LIVE : ACCENT_SLEEP
}

/** Deterministic 16:9 "capture" art — stable across reloads per uuid. */
function captureArt(node: SpatialTabNodeRecord): { backgroundImage: string; backgroundSize: string } {
  const hue = hashHue(node.uuid)
  const hue2 = (hue + 47) % 360
  return {
    backgroundImage: [
      `radial-gradient(120% 90% at 18% 12%, hsl(${hue} 62% 24%) 0%, transparent 58%)`,
      `radial-gradient(110% 100% at 84% 82%, hsl(${hue2} 55% 20%) 0%, transparent 55%)`,
      `radial-gradient(var(--color-grid) 1px, transparent 1px)`,
    ].join(', '),
    backgroundSize: 'auto, auto, 11px 11px',
  }
}

function ghostMatchPercent(node: SpatialTabNodeRecord): number {
  return Math.round((node.ghostMatch ?? 0) * 100)
}

function ageDaysLabel(node: SpatialTabNodeRecord, now: number): string {
  return `${Math.max(0, Math.floor(daysSince(node.lastVisitedAt, now)))}D`
}

/** Region-cluster title carriers at macro zoom: pinned anchors (§6). */
function isPinnedCarrier(node: SpatialTabNodeRecord): boolean {
  return node.isPinned && node.nodeType !== 'ghost-echo'
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

function FaviconTile({ node, size = 22 }: { node: SpatialTabNodeRecord; size?: number }) {
  const isHub = node.nodeType === 'hub'
  const hue = hashHue(node.urlHash)
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg border font-mono font-semibold',
        isHub ? 'border-white/15 text-white/60' : 'border-white/15 text-white/85',
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.45)),
        backgroundColor: isHub ? 'rgba(148, 163, 184, 0.14)' : `hsl(${hue} 45% 16%)`,
        borderColor: isHub ? undefined : `hsl(${hue} 45% 30% / 0.9)`,
      }}
    >
      {faviconLetter(node.domain)}
    </span>
  )
}

/** §4.1 — pulsing 6px status dot for live/active cards. */
function LiveDot({ className }: { className?: string }) {
  return <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full bg-accent animate-pulse', className)} />
}

/** §5.3 — animated equalizer shown on audible tabs (click toggles the mock audio). */
function EqualizerBars({ className, bars = 4 }: { className?: string; bars?: number }) {
  return (
    <span aria-hidden className={cn('flex h-3 items-end gap-[2px]', className)}>
      {Array.from({ length: bars }, (_, index) => (
        <span
          key={index}
          className="stn-eq w-[2px] rounded-full bg-accent"
          style={{ height: '100%', transformOrigin: 'bottom', animationDelay: `${index * 0.14}s`, animationDuration: `${0.7 + (index % 3) * 0.12}s` }}
        />
      ))}
    </span>
  )
}

function AudibleButton({ node }: { node: SpatialTabNodeRecord }) {
  const toggle = (event: ReactMouseEvent) => {
    event.stopPropagation()
    useGraphStore.getState().toggleAudible(node.uuid)
  }
  return (
    <button
      type="button"
      onClick={toggle}
      onDoubleClick={(event) => event.stopPropagation()}
      title={node.isAudible ? 'Audio playing — click to mute' : 'Muted — click to play mock audio'}
      className="nodrag flex items-center gap-1 rounded-md border border-hairline bg-white/[0.04] px-1.5 py-1 transition-colors hover:border-accent/40"
    >
      {node.isAudible ? <EqualizerBars /> : <span className="h-3 w-[10px]" aria-hidden />}
    </button>
  )
}

/** Mono status badge — `LIVE · 138 MB` / `SLEEP · 0 MB` / ghost match (§4.1–§4.3). */
function RamBadge({ node }: { node: SpatialTabNodeRecord }) {
  if (node.nodeType === 'ghost-echo') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-violet-400/40 bg-violet-500/10 px-1.5 py-0.5 font-mono text-[10px] tracking-ui text-violet-300">
        GHOST ECHO · {ghostMatchPercent(node)}% MATCH
      </span>
    )
  }
  if (node.ramState === 'live') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] tracking-ui text-accent">
        <LiveDot />
        LIVE · {formatRamMb(node.ramMb)}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-sky-300/20 bg-sky-400/10 px-1.5 py-0.5 font-mono text-[10px] tracking-ui text-sky-200/80">
      SLEEP · {formatRamMb(node.ramMb)}
    </span>
  )
}

function RegionChip({ regionName, regionColor }: { regionName: string | null; regionColor: string | null }) {
  if (!regionName) {
    return <span className="rounded-md border border-hairline px-1.5 py-0.5 font-mono text-[9px] text-white/30">UNREGIONED</span>
  }
  return (
    <span className="inline-flex max-w-[130px] items-center gap-1 rounded-md border border-hairline bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-white/60">
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: regionColor ?? ACCENT_HUB }} />
      <span className="truncate">{regionName}</span>
    </span>
  )
}

/** §7.1 — subtle search-query pill tag on hub destination nodes. */
function SearchQueryTag({ query }: { query: string }) {
  return (
    <span className="inline-flex max-w-[150px] items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[9px] text-white/50">
      <Search size={9} className="shrink-0" />
      <span className="truncate">{query}</span>
    </span>
  )
}

/** §7.2 — oauth/payment redirect chains collapse into one node with this tag. */
function ViaAuthTag() {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-amber-300/25 bg-amber-400/10 px-1.5 py-0.5 font-mono text-[9px] text-amber-200/75">
      <Lock size={9} />
      VIA AUTH
    </span>
  )
}

/** §4.2 — untouched > 14 days dims into the Cold Archive (§6 visual decay). */
function ColdArchiveChip({ days }: { days: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[9px] text-white/40">
      <Snowflake size={9} />
      COLD ARCHIVE · {days}
    </span>
  )
}

function WorkbenchChip() {
  return (
    <span
      className="rounded-md border border-accent/30 bg-accent/10 px-1.5 py-0.5 font-mono text-[9px] text-accent/85"
      title="Pulled into the Active Workbench tray (§6 gravity well)"
    >
      WB
    </span>
  )
}

/** §4.6 — pinned anchors carry a subtle pin glyph; satellites an orbit glyph. */
function PinGlyph({ isPinned }: { isPinned: boolean }) {
  return (
    <span
      title={isPinned ? 'Pinned anchor — (fx, fy) locked, physics never drifts it' : 'Anchor state'}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-md border px-1 py-0.5 font-mono text-[9px]',
        isPinned ? 'border-accent/35 bg-accent/10 text-accent' : 'border-hairline text-white/35',
      )}
    >
      {isPinned ? <Pin size={9} /> : <PinOff size={9} />}
      {isPinned ? 'ANCHOR' : null}
    </span>
  )
}

function SatelliteGlyph() {
  return (
    <span title="Orbiting satellite — spawned radially from its parent (§4.6)" className="text-white/35">
      <Orbit size={11} />
    </span>
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
      <div className={cn('nodrag w-[200px] rounded-xl border border-sticky/45 bg-sticky-glass p-2 shadow-lg backdrop-blur-md', className)}>
        <textarea
          value={draft}
          autoFocus
          rows={3}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={save}
          placeholder="Write on the sticky note…"
          className="nowheel w-full resize-none rounded-md bg-transparent text-[11px] leading-snug text-sticky-soft outline-none placeholder:text-white/30"
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
            className="nodrag rounded-md border border-sticky/40 bg-sticky/15 p-1 text-sticky transition-colors hover:bg-sticky/25"
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
            className="nodrag rounded-md border border-hairline p-1 text-white/45 transition-colors hover:text-rose-300"
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
        'nodrag w-[200px] cursor-text rounded-xl border border-sticky/30 bg-sticky-glass p-2 text-left shadow-md backdrop-blur-sm transition-colors hover:border-sticky/50',
        className,
      )}
    >
      {note.text.trim() ? (
        <span className="line-clamp-3 text-[11px] leading-snug text-sticky-soft">{note.text}</span>
      ) : (
        <span className="text-[11px] italic leading-snug text-white/30">Click to write…</span>
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
    <div className="nodrag group/memo relative flex w-[236px] items-center gap-2 overflow-hidden rounded-xl border border-hairline bg-surface-glass px-2 py-1.5 shadow-sm backdrop-blur-md">
      <button
        type="button"
        onClick={toggle}
        onDoubleClick={(event) => event.stopPropagation()}
        title={isPlaying ? (isPaused ? 'Resume voice memo' : 'Pause voice memo') : 'Play voice memo'}
        className="nodrag flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-accent/35 bg-accent/10 text-accent transition-colors hover:bg-accent/20"
      >
        {isPlaying && !isPaused ? <Pause size={12} /> : <Play size={12} />}
      </button>
      {/* 12-bar visualizer — deterministic bar profile; animates while playing. */}
      <span className="relative flex h-5 min-w-0 flex-1 items-end gap-[2px] pb-[2px]" aria-hidden>
        {profile.map((level, index) => (
          <motion.span
            key={index}
            className="w-[3px] shrink-0 rounded-full bg-accent/80"
            style={{ height: `${Math.round(4 + level * 14)}px`, transformOrigin: 'bottom' }}
            animate={isPlaying && !isPaused ? { scaleY: [1, 0.35, 1] } : { scaleY: 1 }}
            transition={{ duration: 0.9, repeat: isPlaying && !isPaused ? Infinity : 0, ease: 'easeInOut', delay: index * 0.07 }}
          />
        ))}
        <motion.span
          className="absolute bottom-0 left-0 h-[2px] w-full origin-left rounded-full bg-accent"
          animate={{ scaleX: progress }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
        />
      </span>
      <span className="shrink-0 font-mono text-[10px] text-white/70">{formatDurationMs(memo.durationMs)}</span>
      <button
        type="button"
        onClick={stop}
        title="Stop playback"
        className={cn(
          'nodrag shrink-0 rounded-md border border-hairline p-1 text-white/45 transition-colors hover:text-white/80',
          isPlaying ? 'opacity-100' : 'opacity-0 transition-opacity group-hover/memo:opacity-100',
        )}
      >
        <Square size={9} />
      </button>
      <button
        type="button"
        onClick={remove}
        title="Delete voice memo"
        className="nodrag shrink-0 rounded-md border border-hairline p-1 text-white/45 opacity-0 transition-colors group-hover/memo:opacity-100 hover:text-rose-300"
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
      <div className="nodrag flex items-center gap-2 rounded-xl border border-accent/35 bg-accent/10 px-2 py-1.5">
        <span className="font-mono text-[10px] text-accent">{formatDurationMs(pending.durationMs)} TAKE</span>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            recorder.commitPending()
            onDone()
          }}
          title="Save voice memo to this node"
          className="nodrag rounded-md border border-accent/40 bg-accent/15 p-1 text-accent"
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
          className="nodrag rounded-md border border-hairline p-1 text-white/50"
        >
          <Trash2 size={11} />
        </button>
      </div>
    )
  }

  if (recorder.error && !recorder.isRecording) {
    return (
      <div className="nodrag flex max-w-[236px] items-center gap-2 rounded-xl border border-rose-400/30 bg-rose-500/10 px-2 py-1.5">
        <span className="truncate text-[10px] text-rose-200/85">{recorder.error}</span>
        <button type="button" onClick={onDone} title="Close" className="nodrag rounded-md border border-hairline p-1 text-white/50">
          <X size={10} />
        </button>
      </div>
    )
  }

  if (recorder.isRecording) {
    return (
      <div className="nodrag flex w-[236px] items-center gap-2 rounded-xl border border-rose-400/35 bg-rose-500/10 px-2 py-1.5">
        <span className="stn-rec-blink h-1.5 w-1.5 shrink-0 rounded-full bg-rose-400" aria-hidden />
        <span className="shrink-0 font-mono text-[10px] text-rose-200">{formatDurationMs(recorder.elapsedMs)}</span>
        <span className="flex h-5 min-w-0 flex-1 items-end gap-[2px]" aria-hidden>
          {recorder.liveLevels.slice(0, LIVE_LEVEL_BARS).map((level, index) => (
            <span
              key={index}
              className="w-[3px] shrink-0 rounded-full bg-rose-300/85"
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
          className="nodrag rounded-md border border-rose-300/40 bg-rose-400/15 p-1 text-rose-200"
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
          className="nodrag rounded-md border border-hairline p-1 text-white/50"
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
        <code key={`${keyPrefix}-${index}`} className="rounded bg-white/5 px-1 py-0.5 font-mono text-[11px] text-accent/90">
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
    if (trimmed === '---') return <hr key={key} className="my-3 border-hairline" />
    if (line.startsWith('> ')) {
      return (
        <blockquote key={key} className="border-l-2 border-sticky/40 pl-3 text-[12px] italic text-white/60">
          {renderInlineMarkdown(line.slice(2), key)}
        </blockquote>
      )
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      return (
        <h3 key={key} className={cn('font-semibold text-white/90', heading[1].length === 1 ? 'text-[15px]' : 'text-[13px]')}>
          {heading[2]}
        </h3>
      )
    }
    const italicLine = /^\*\((.+)\)\*$/.exec(trimmed)
    if (italicLine) {
      return (
        <p key={key} className="text-[11px] italic text-white/40">
          {italicLine[1]}
        </p>
      )
    }
    return (
      <p key={key} className="text-[13px] leading-relaxed text-white/80">
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
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/65 p-6 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-label={`Cached text — ${node.title}`}
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[72vh] w-[560px] max-w-full flex-col overflow-hidden rounded-2xl border border-hairline bg-surface-glass shadow-2xl backdrop-blur-2xl"
      >
        <div className="flex items-center gap-2 border-b border-hairline px-4 py-3">
          <FileText size={14} className="shrink-0 text-sticky" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-white/90">{node.title}</div>
            <div className="truncate font-mono text-[10px] text-white/40">{node.url}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close cached text"
            className="rounded-md border border-hairline p-1.5 text-white/55 transition-colors hover:text-white"
          >
            <X size={13} />
          </button>
        </div>
        <div className="overflow-y-auto px-4 py-4">{renderExcerptMarkdown(node.excerpt ?? '')}</div>
        <div className="border-t border-hairline px-4 py-2 font-mono text-[9px] text-white/30">
          CACHED READABILITY SNAPSHOT · DEAD LINK (§7.5)
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ------------------------------------------------------------------ */
/* MACRO tier — pure beacons (§4.1, zoom < 0.35)                       */
/* ------------------------------------------------------------------ */

function MacroBeacon({
  node,
  regionName,
  regionColor,
  isActive,
  childCount,
  isStackCollapsed,
  interactions,
}: {
  node: SpatialTabNodeRecord
  regionName: string | null
  regionColor: string | null
  isActive: boolean
  childCount: number
  isStackCollapsed: boolean
  interactions: NodeInteractions
}) {
  const now = Date.now()
  const cold = isColdArchive(node, now)
  const isGhost = node.nodeType === 'ghost-echo'
  const isHub = node.nodeType === 'hub'
  const accent = accentFor(node)
  const showDeck = isStackCollapsed && childCount > 0
  const carrier = isPinnedCarrier(node)

  // Region anchors carry the large high-contrast region-cluster title (§4.1/§6).
  const showLabel = carrier || isActive || showDeck

  return (
    <div
      className="nodrag relative flex h-6 w-6 items-center justify-center"
      onClick={interactions.activate}
      onDoubleClick={(event) => {
        event.stopPropagation()
        interactions.toggleStack()
      }}
    >
      {isActive && !isGhost && <span aria-hidden className="absolute inset-[-5px] animate-ping rounded-full bg-accent/25" />}
      {isGhost && <span aria-hidden className="stn-ghost-breathe absolute inset-[-4px] rounded-full" />}
      <span
        className={cn(
          'block h-6 w-6 rounded-full border',
          isGhost ? 'border-dashed border-violet-400/70 bg-violet-950/40' : isHub ? 'border-white/15 bg-slate-600/50' : '',
          !isGhost && !isHub && node.ramState === 'live' && 'border-accent/70',
          !isGhost && !isHub && node.ramState === 'hibernated' && 'border-hairline bg-surface',
          cold && 'opacity-65',
        )}
        style={!isGhost && !isHub && node.ramState === 'live' ? { backgroundColor: accent, boxShadow: `0 0 12px ${accent}66` } : undefined}
      />
      {node.isPinned && <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-void bg-accent" />}
      {showDeck && (
        <span className="absolute -bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-accent/40 bg-void/80 px-1.5 py-px font-mono text-[9px] text-accent">
          +{childCount}
        </span>
      )}
      {showLabel && (
        <span
          className={cn(
            'pointer-events-none absolute left-1/2 top-7 max-w-[240px] -translate-x-1/2 truncate whitespace-nowrap text-center text-[12px] font-semibold tracking-ui text-white/90',
            carrier && 'drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]',
          )}
          style={carrier && regionColor ? { borderBottom: `2px solid ${regionColor}` } : undefined}
        >
          {carrier ? (regionName ?? node.title).toUpperCase() : node.title}
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
  const accent = accentFor(node)
  const showDeck = isStackCollapsed && childCount > 0

  return (
    <div
      className={cn(
        'nodrag relative flex h-[44px] w-[180px] cursor-pointer items-center gap-2 rounded-2xl border px-2 backdrop-blur-md',
        isGhost && 'stn-ghost-breathe border-dashed border-violet-400/50 bg-violet-950/25',
        !isGhost && 'bg-surface-glass',
        !isGhost && node.ramState === 'live' && 'border-accent/55',
        !isGhost && node.ramState === 'live' && isActive && 'shadow-[0_0_0_1px_rgba(52,211,153,0.28),0_0_18px_rgba(52,211,153,0.2)]',
        !isGhost && node.ramState === 'hibernated' && 'border-hairline opacity-90 saturate-75',
        cold && 'opacity-65',
      )}
      onClick={interactions.activate}
      onDoubleClick={(event) => {
        event.stopPropagation()
        interactions.toggleStack()
      }}
      title={`${node.title} — click to ${node.ramState === 'hibernated' ? 'wake' : 'activate'}`}
    >
      <FaviconTile node={node} size={22} />
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-white/85">{node.title}</span>
      <span className="flex shrink-0 items-center gap-1.5">
        {node.isLoading && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" title="Loading…" />}
        {node.isAudible && <EqualizerBars bars={3} className="h-2.5" />}
        {noteCount > 0 && <StickyNote size={12} className="text-sticky" />}
        {hasVoiceMemo && <span className="h-1.5 w-1.5 rounded-full bg-accent/80" title="Has voice memo" />}
        {node.isPinned && <Pin size={12} className="text-accent" />}
        {showDeck && (
          <span className="rounded-full border border-accent/40 bg-accent/10 px-1 font-mono text-[9px] text-accent">+{childCount}</span>
        )}
      </span>
      {!isGhost && node.ramState === 'live' && (
        <span
          aria-hidden
          className="absolute -left-px top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-full"
          style={{ backgroundColor: accent, boxShadow: `0 0 8px ${accent}55` }}
        />
      )}
      <StnHandles />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* §7.1 — hub super-node: small neutral router chip (rich tier)        */
/* ------------------------------------------------------------------ */

function HubRouterChip({
  node,
  childCount,
  isStackCollapsed,
  interactions,
}: {
  node: SpatialTabNodeRecord
  childCount: number
  isStackCollapsed: boolean
  interactions: NodeInteractions
}) {
  const showDeck = isStackCollapsed && childCount > 0
  return (
    <div
      className="nodrag relative flex w-[220px] cursor-pointer items-center gap-2 rounded-xl border border-hairline bg-surface-glass px-2.5 py-2 backdrop-blur-md"
      onClick={interactions.activate}
      onDoubleClick={(event) => {
        event.stopPropagation()
        interactions.toggleStack()
      }}
      title="Ephemeral search-hub router — click to route"
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/15 bg-white/[0.05] text-white/55">
        <Network size={14} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[11px] text-white/70">{node.domain}</span>
        <span className="block font-mono text-[9px] tracking-ui text-white/35">HUB ROUTER · EPHEMERAL</span>
      </span>
      {node.searchQuery && <SearchQueryTag query={node.searchQuery} />}
      {showDeck && (
        <span className="shrink-0 rounded-full border border-accent/40 bg-accent/10 px-1.5 py-px font-mono text-[9px] text-accent">
          +{childCount}
        </span>
      )}
      <StnHandles />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* §4.3 — ghost echo node (rich-tier card; compact/macro above)        */
/* ------------------------------------------------------------------ */

function GhostEchoCard({ node, interactions }: { node: SpatialTabNodeRecord; interactions: NodeInteractions }) {
  const dismiss = (event: ReactMouseEvent) => {
    event.stopPropagation()
    useGraphStore.getState().dismissGhostEcho(node.uuid)
  }
  const wake = (event: ReactMouseEvent) => {
    event.stopPropagation()
    useGraphStore.getState().wakeGhostEcho(node.uuid)
  }

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={SPRING}
      className="stn-ghost-breathe nodrag relative w-[260px] cursor-pointer rounded-2xl border border-dashed border-violet-400/50 bg-violet-950/20 p-3 backdrop-blur-md"
      onClick={interactions.activate}
      title="Ghost Echo — predicted resurfacing of a sleeping tab. Click to wake."
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-violet-400/40 bg-violet-500/10 text-violet-300">
          <Ghost size={13} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-[13px] font-medium leading-snug text-violet-100/90">{node.title}</div>
          <div className="mt-0.5 truncate font-mono text-[10px] text-violet-300/60">{node.domain}</div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          title="Dismiss ghost echo (suppresses this URL for the session)"
          className="nodrag shrink-0 rounded-md border border-hairline p-1 text-white/50 transition-colors hover:text-rose-300"
        >
          <X size={11} />
        </button>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <RamBadge node={node} />
        <button
          type="button"
          onClick={wake}
          title="Wake Here — links/wakes the predicted tab"
          className="nodrag rounded-lg border border-violet-400/45 bg-violet-500/15 px-2 py-1 font-mono text-[10px] tracking-ui text-violet-200 transition-colors hover:bg-violet-500/30"
        >
          <span className="inline-flex items-center gap-1">
            <Zap size={10} />
            WAKE HERE
          </span>
        </button>
      </div>
      {node.excerpt && (
        <div className="mt-2 line-clamp-2 rounded-lg border border-hairline bg-white/[0.03] px-2 py-1.5 text-[10px] leading-snug text-white/45">
          {node.excerpt}
        </div>
      )}
      <StnHandles />
    </motion.div>
  )
}

/* ------------------------------------------------------------------ */
/* RICH tier — the full 260px spatial card (§4.3, zoom ≥ 0.65)         */
/* ------------------------------------------------------------------ */

function RichCard({
  node,
  regionName,
  regionColor,
  isActive,
  isWorkbench,
  childCount,
  isStackCollapsed,
  selected,
  dragging,
  interactions,
}: {
  node: SpatialTabNodeRecord
  regionName: string | null
  regionColor: string | null
  isActive: boolean
  isWorkbench: boolean
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
  const primaryNote = notes[0]
  const extraNotes = allNotesOpen ? notes.slice(1) : []
  const recordingHere = storeRecordingNodeId === node.uuid

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

  const wake = (event: ReactMouseEvent) => {
    event.stopPropagation()
    useGraphStore.getState().wakeNode(node.uuid)
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
    <div
      className={cn(
        'nodrag relative w-[260px] cursor-pointer rounded-2xl border bg-surface-glass backdrop-blur-xl',
        'shadow-[0_18px_50px_-12px_rgba(0,0,0,0.65)]',
        isLive && 'border-accent/55',
        isLive && isActive && 'shadow-[0_0_0_1px_rgba(52,211,153,0.3),0_0_26px_rgba(52,211,153,0.22),0_18px_50px_-12px_rgba(0,0,0,0.65)]',
        isHibernated && 'border-hairline opacity-90 saturate-75',
        cold && 'opacity-65',
        dragging && 'shadow-[0_28px_70px_-16px_rgba(0,0,0,0.8)]',
        selected && 'ring-1 ring-white/35',
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDoubleClick={(event) => {
        event.stopPropagation()
        interactions.toggleStack()
      }}
    >
      {/* §4.5 — layered deck behind the collapsed stack */}
      <AnimatePresence initial={false}>
        {showDeck && (
          <div key="deck" className="pointer-events-none absolute inset-0">
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={SPRING}
              className="absolute -bottom-2 left-4 right-4 top-4 rounded-2xl border border-hairline bg-surface/55"
            />
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 12 }}
              transition={SPRING}
              className="absolute -bottom-4 left-8 right-8 top-8 rounded-2xl border border-hairline bg-surface/30"
            />
          </div>
        )}
      </AnimatePresence>

      {/* §4.1 — hover actions over the thumbnail header */}
      <AnimatePresence>
        {hovered && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.96 }}
            transition={SPRING}
            className="absolute left-1/2 top-2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-hairline bg-void/85 px-1.5 py-1 shadow-xl backdrop-blur-xl"
          >
            <button
              type="button"
              onClick={openViewport}
              title="Open Viewport — focus this tab in the reading view"
              className="nodrag rounded-md p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-accent"
            >
              <ScanEye size={13} />
            </button>
            {isLive ? (
              <button
                type="button"
                onClick={hibernate}
                title="Hibernate · 0 MB"
                className="nodrag rounded-md p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-sky-200"
              >
                <Snowflake size={13} />
              </button>
            ) : (
              <button
                type="button"
                onClick={wake}
                title="Wake to LIVE"
                className="nodrag rounded-md p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-accent"
              >
                <Zap size={13} />
              </button>
            )}
            <button
              type="button"
              onClick={togglePin}
              title={node.isPinned ? 'Unpin anchor — release (fx, fy)' : 'Pin Anchor — lock (fx, fy) so physics never drifts it'}
              className="nodrag rounded-md p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-accent"
            >
              {node.isPinned ? <PinOff size={13} /> : <Pin size={13} />}
            </button>
            <button
              type="button"
              onClick={addNote}
              title="+ Note — attach a sticky note to this URL (shared across duplicates)"
              className="nodrag rounded-md p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-sticky"
            >
              <Plus size={13} />
            </button>
            <button
              type="button"
              onClick={startRecording}
              title="Record a voice memo on this node"
              className="nodrag rounded-md p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-rose-300"
            >
              <Mic size={13} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 16:9 thumbnail header — 146px tall on the 260px card (§4.3) */}
      <div className="relative h-[146px] overflow-hidden rounded-t-2xl border-b border-hairline">
        {node.noCapture ? (
          /* §7.4 — private/sensitive: blur-glass placeholder, never a real capture */
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-surface/55 backdrop-blur-xl">
            <CameraOff size={22} className="text-white/35" />
            <span className="font-mono text-[10px] tracking-ui text-white/40">NO CAPTURE · PRIVATE</span>
          </div>
        ) : (
          <>
            <div className="absolute inset-0" style={captureArt(node)} />
            <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/55 to-transparent" />
            <span className="absolute bottom-2 left-2 font-mono text-[10px] text-white/55">{node.domain}</span>
          </>
        )}

        {node.isLoading && (
          <div className="absolute inset-0 overflow-hidden bg-black/25">
            <div className="absolute inset-y-0 w-1/3 bg-white/10 blur-md" style={{ animation: 'stn-shimmer-slide 1.1s ease-in-out infinite' }} />
            <span className="absolute bottom-2 right-2 rounded-md border border-accent/30 bg-void/80 px-1.5 py-0.5 font-mono text-[9px] text-accent">
              LOADING…
            </span>
          </div>
        )}

        <div className="absolute left-2 top-2 z-10 flex items-center gap-1.5 rounded-lg border border-hairline bg-void/70 px-1.5 py-1 backdrop-blur-md">
          <FaviconTile node={node} size={16} />
          <span className="max-w-[92px] truncate font-mono text-[10px] text-white/70">{node.domain}</span>
        </div>
        <div className="absolute right-2 top-2 z-10">
          <RamBadge node={node} />
        </div>
        {node.isAudible && (
          <div className="absolute bottom-2 right-2 z-10">
            <AudibleButton node={node} />
          </div>
        )}
        {/* §7.5 — cached-text chip on hibernated (dead-link) cards */}
        {isHibernated && node.excerpt && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              setExcerptOpen(true)
            }}
            title="Open cached text snapshot"
            className="nodrag absolute bottom-2 left-2 z-10 inline-flex items-center gap-1 rounded-md border border-sticky/30 bg-sticky-glass px-1.5 py-0.5 font-mono text-[9px] text-sticky/90 backdrop-blur-md transition-colors hover:border-sticky/60"
          >
            <FileText size={9} />
            CACHED TEXT
          </button>
        )}
      </div>

      {/* Body */}
      <div className="relative z-10 px-3 pb-3 pt-2.5">
        <div className="line-clamp-2 text-[13px] font-medium leading-snug text-white/90">{node.title}</div>
        <div className="mt-1 flex items-center gap-1.5">
          <span className="truncate font-mono text-[10px] text-white/45">{node.domain}</span>
          {!node.isPinned && node.parentUuid !== null && <SatelliteGlyph />}
          <span className="flex-1" />
          {node.isAudible && <AudibleButton node={node} />}
        </div>

        {/* Context badges */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <RegionChip regionName={regionName} regionColor={regionColor} />
          {isWorkbench && !isActive && <WorkbenchChip />}
          {node.viaAuth && <ViaAuthTag />}
          {node.searchQuery && <SearchQueryTag query={node.searchQuery} />}
          <span className="rounded-md border border-hairline px-1.5 py-0.5 font-mono text-[9px] text-white/35" title="Last visited">
            {ageDaysLabel(node, now)} AGO
          </span>
          {cold && <ColdArchiveChip days={ageDaysLabel(node, now)} />}
          <PinGlyph isPinned={node.isPinned} />
        </div>

        {(recordingHere || recordingOpen) && <RecordingPanel nodeId={node.uuid} onDone={closeRecording} />}

        {memos.length > 0 && (
          <div className="mt-2 flex flex-col gap-1.5">
            {memos.map((memo) => (
              <VoiceMemoPill key={memo.id} memo={memo} />
            ))}
          </div>
        )}

        {/* §7.3 — SPA pushState trail as an expandable filmstrip */}
        {node.subPages.length > 0 && (
          <div className="nodrag mt-2">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                setFilmstripOpen((open) => !open)
              }}
              title="Expand the SPA navigation trail"
              className="nodrag inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-white/[0.03] px-2 py-1 font-mono text-[10px] text-white/55 transition-colors hover:border-accent/35 hover:text-white/80"
            >
              <Film size={11} />
              {node.subPages.length} SPA STOPS
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
                  <div className="mt-1.5 space-y-1">
                    {node.subPages.map((sub, index) => (
                      <button
                        key={sub.url}
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          openSubPage(sub)
                        }}
                        title={`Navigate this node to ${sub.url}`}
                        className="nodrag flex w-full items-center gap-2 rounded-lg border border-hairline bg-white/[0.03] px-2 py-1.5 text-left transition-colors hover:border-accent/40"
                      >
                        <span className="shrink-0 font-mono text-[9px] text-accent/70">{String(index + 1).padStart(2, '0')}</span>
                        <span className="min-w-0 flex-1 truncate text-[11px] text-white/75">{sub.title}</span>
                        <ArrowUpRight size={11} className="shrink-0 text-white/30" />
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* §4.4 — extra notes expand inline below the tucked card */}
        {extraNotes.map((note, index) => (
          <StickyNoteCard
            key={note.id}
            note={note}
            isEditing={editingNoteId === note.id}
            onEdit={setEditingNoteId}
            onDismissEditor={dismissEditor}
            className={cn('relative mt-2', index % 2 === 1 ? 'rotate-[0.8deg]' : '-rotate-[0.8deg]')}
          />
        ))}
      </div>

      {/* §4.4 — the tactile sticky note tucked under the bottom-right edge */}
      {primaryNote && !allNotesOpen && (
        <div className="absolute -bottom-5 right-3 z-20 rotate-[-1.5deg]">
          <StickyNoteCard
            note={primaryNote}
            isEditing={editingNoteId === primaryNote.id}
            onEdit={setEditingNoteId}
            onDismissEditor={dismissEditor}
          />
          {notes.length > 1 && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                setAllNotesOpen(true)
              }}
              title={`Show all ${notes.length} notes (shared by duplicate URLs of this page)`}
              className="nodrag absolute -left-3 -top-2 rounded-full border border-sticky/40 bg-void/85 px-1.5 py-px font-mono text-[9px] text-sticky shadow"
            >
              ×{notes.length}
            </button>
          )}
        </div>
      )}
      {primaryNote && allNotesOpen && (
        <div className="absolute inset-x-0 -bottom-8 z-30 flex justify-center">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              setAllNotesOpen(false)
              setEditingNoteId(null)
            }}
            title="Collapse notes back into the tucked card"
            className="nodrag rounded-full border border-sticky/40 bg-void/85 px-2 py-0.5 font-mono text-[9px] text-sticky shadow"
          >
            <span className="inline-flex items-center gap-1">
              <StickyNote size={9} />
              {notes.length} NOTES — COLLAPSE
            </span>
          </button>
        </div>
      )}

      {/* §4.5 — +N TABS deck badge */}
      {showDeck && (
        <div className="pointer-events-none absolute -bottom-7 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full border border-accent/40 bg-void/85 px-2 py-0.5 font-mono text-[10px] tracking-ui text-accent shadow-lg">
          <Layers size={10} />
          +{childCount} TABS
        </div>
      )}

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
  const { node, lod, regionName, regionColor, isActive, isWorkbench, childCount, isStackCollapsed } = props.data

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
        <HubRouterChip node={node} childCount={childCount} isStackCollapsed={isStackCollapsed} interactions={interactions} />
      </div>
    )
  }
  if (lod === 'macro') {
    return (
      <div onPointerDown={handlePointerDown} className="w-fit">
        <MacroBeacon
          node={node}
          regionName={regionName}
          regionColor={regionColor}
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
    <div onPointerDown={handlePointerDown}>
      <RichCard
        node={node}
        regionName={regionName}
        regionColor={regionColor}
        isActive={isActive}
        isWorkbench={isWorkbench}
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
  return (
    a.lod === b.lod &&
    a.semanticZoomOverride === b.semanticZoomOverride &&
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
