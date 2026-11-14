/**
 * app/src/hooks/useVoiceRecorder.ts — real MediaRecorder voice memos with
 * blob-URL playback (SPEC §1, §4.4, §5.3, §8).
 *
 * Capture: getUserMedia → MediaRecorder (WebM/Opus preferred) → Blob. The
 * just-recorded take is previewed through a `blob:` URL; on commit the Blob
 * is additionally converted to a `data:` URL so the memo survives zustand
 * persist (§8 "persistence of audio blobs").
 *
 * Playback: a module-level singleton <audio> drives `blob:` URLs — recorded
 * previews directly, persisted memos after a one-time data-URL→blob-URL
 * conversion (cached per memo id).
 *
 * The hook is safe to mount in many components simultaneously: capture and
 * playback state live in module-level external stores read via
 * `useSyncExternalStore`, so every instance sees the same truth (exactly one
 * recorder, one playing memo). Recording sets `recordingNodeId` in the graph
 * store, which grants the node auto-hibernation immunity (§5.3).
 */
import { useEffect, useSyncExternalStore } from 'react'
import { fnv1a32 } from '../lib/embed'
import { useGraphStore } from '../store/useGraphStore'
import type { MemoId, NodeUuid, VoiceMemo } from '../lib/types'

export const LIVE_LEVEL_BARS = 12

export type VoiceRecorderPending = {
  nodeId: NodeUuid
  /** blob: URL of the raw take — revoked on commit/discard. */
  blobUrl: string
  /** data: URL persisted with the memo so it survives reloads (§8). */
  dataUrl: string
  durationMs: number
  mimeType: string
}

export type VoiceRecorderApi = {
  isSupported: boolean
  isRecording: boolean
  recordingNodeId: NodeUuid | null
  /** Elapsed capture time in ms (drives the live timer chip). */
  elapsedMs: number
  /** Rolling 12-bar live level meter, each 0..1 (feeds the animated waveform). */
  liveLevels: number[]
  error: string | null
  /** Last completed take awaiting commit/discard. */
  pending: VoiceRecorderPending | null
  /** Currently playing memo id (null when silent). */
  playingMemoId: MemoId | null
  isPlaybackPaused: boolean
  /** Playback progress 0..1. */
  playbackProgress: number

  /** Begin capture on a node (grants §5.3 hibernation immunity). */
  start: (nodeId: NodeUuid) => Promise<void>
  /** Finalize the take → fills `pending`. */
  stop: () => void
  /** Abort capture without keeping the take. */
  cancel: () => void
  /** Persist `pending` into the store as a VoiceMemo; returns the memo id. */
  commitPending: (title?: string) => MemoId | null
  /** Throw the pending take away. */
  discardPending: () => void
  /** Play a memo (blob-URL playback); toggling is via pause/resume/stop. */
  playMemo: (memo: VoiceMemo) => void
  pausePlayback: () => void
  resumePlayback: () => void
  stopPlayback: () => void
}

/* ------------------------------------------------------------------ */
/* Recorder singleton state (external store)                           */
/* ------------------------------------------------------------------ */

type RecorderRuntimeState = {
  isSupported: boolean
  isRecording: boolean
  recordingNodeId: NodeUuid | null
  elapsedMs: number
  liveLevels: number[]
  error: string | null
  pending: VoiceRecorderPending | null
}

function detectSupport(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  )
}

function zeroLevels(): number[] {
  return new Array<number>(LIVE_LEVEL_BARS).fill(0)
}

let recorderState: RecorderRuntimeState = {
  isSupported: detectSupport(),
  isRecording: false,
  recordingNodeId: null,
  elapsedMs: 0,
  liveLevels: zeroLevels(),
  error: null,
  pending: null,
}

const recorderListeners = new Set<() => void>()

function setRecorderState(patch: Partial<RecorderRuntimeState>): void {
  recorderState = { ...recorderState, ...patch }
  for (const listener of recorderListeners) listener()
}

function subscribeRecorder(listener: () => void): () => void {
  recorderListeners.add(listener)
  return () => {
    recorderListeners.delete(listener)
  }
}

/* Recorder machinery — module-level so capture is a true app singleton. */
type RecorderMachinery = {
  recorder: MediaRecorder | null
  stream: MediaStream | null
  audioCtx: AudioContext | null
  analyser: AnalyserNode | null
  chunks: Blob[]
  timer: ReturnType<typeof setInterval> | null
  levelTimer: ReturnType<typeof setInterval> | null
  startedAt: number
  mimeType: string
  pendingNodeId: NodeUuid | null
  discardOnStop: boolean
}

const machinery: RecorderMachinery = {
  recorder: null,
  stream: null,
  audioCtx: null,
  analyser: null,
  chunks: [],
  timer: null,
  levelTimer: null,
  startedAt: 0,
  mimeType: '',
  pendingNodeId: null,
  discardOnStop: false,
}

const RECORDING_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
] as const

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  for (const candidate of RECORDING_MIME_CANDIDATES) {
    try {
      if (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(candidate)) return candidate
    } catch {
      // isTypeSupported can throw on exotic platforms — keep trying.
    }
  }
  return ''
}

function getAudioContextCtor(): (typeof AudioContext) | undefined {
  if (typeof window === 'undefined') return undefined
  const webkit = (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  return window.AudioContext ?? webkit
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('voice-recorder: unexpected FileReader result'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('voice-recorder: FileReader failed'))
    reader.readAsDataURL(blob)
  })
}

function releaseCaptureMachinery(): void {
  if (machinery.timer !== null) {
    clearInterval(machinery.timer)
    machinery.timer = null
  }
  if (machinery.levelTimer !== null) {
    clearInterval(machinery.levelTimer)
    machinery.levelTimer = null
  }
  if (machinery.stream) {
    for (const track of machinery.stream.getTracks()) track.stop()
    machinery.stream = null
  }
  if (machinery.audioCtx) {
    void machinery.audioCtx.close().catch(() => undefined)
    machinery.audioCtx = null
    machinery.analyser = null
  }
  machinery.recorder = null
  machinery.chunks = []
}

function finalizeRecording(): void {
  const elapsedMs = Date.now() - machinery.startedAt
  const nodeId = machinery.pendingNodeId
  const mimeType = machinery.mimeType || 'audio/webm'
  const discard = machinery.discardOnStop
  machinery.discardOnStop = false
  releaseCaptureMachinery()
  setRecorderState({ isRecording: false, recordingNodeId: null, elapsedMs, liveLevels: zeroLevels() })
  useGraphStore.getState().setRecordingNode(null)
  if (discard || !nodeId) return

  const blob = new Blob(machinery.chunks, { type: mimeType })
  if (blob.size === 0) return
  const blobUrl = URL.createObjectURL(blob)
  void blobToDataUrl(blob)
    .then((dataUrl) => {
      setRecorderState({
        pending: { nodeId, blobUrl, dataUrl, durationMs: elapsedMs, mimeType },
      })
    })
    .catch((error: unknown) => {
      setRecorderState({ error: error instanceof Error ? error.message : 'voice-recorder: encoding failed' })
    })
}

async function startRecording(nodeId: NodeUuid): Promise<void> {
  if (recorderState.isRecording) return
  if (!recorderState.isSupported) {
    setRecorderState({ error: 'MediaRecorder is not supported in this browser.' })
    return
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const mimeType = pickMimeType()
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    machinery.chunks = []
    machinery.pendingNodeId = nodeId
    machinery.startedAt = Date.now()
    machinery.mimeType = mimeType
    machinery.stream = stream
    machinery.discardOnStop = false
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) machinery.chunks.push(event.data)
    }
    recorder.onstop = () => finalizeRecording()
    recorder.onerror = () => {
      setRecorderState({ error: 'voice-recorder: MediaRecorder error' })
      cancelRecording()
    }
    machinery.recorder = recorder
    recorder.start(250)

    setRecorderState({ isRecording: true, recordingNodeId: nodeId, elapsedMs: 0, liveLevels: zeroLevels(), error: null })
    useGraphStore.getState().setRecordingNode(nodeId)

    machinery.timer = setInterval(() => {
      setRecorderState({ elapsedMs: Date.now() - machinery.startedAt })
    }, 100)

    // Optional live level meter — failure never blocks capture.
    try {
      const Ctor = getAudioContextCtor()
      if (Ctor) {
        const audioCtx = new Ctor()
        const analyser = audioCtx.createAnalyser()
        analyser.fftSize = 512
        audioCtx.createMediaStreamSource(stream).connect(analyser)
        machinery.audioCtx = audioCtx
        machinery.analyser = analyser
        const buffer = new Uint8Array(analyser.fftSize)
        const history: number[] = []
        machinery.levelTimer = setInterval(() => {
          analyser.getByteTimeDomainData(buffer)
          let sumOfSquares = 0
          for (const value of buffer) {
            const centered = (value - 128) / 128
            sumOfSquares += centered * centered
          }
          const rms = Math.min(1, Math.sqrt(sumOfSquares / buffer.length) * 2.2)
          history.push(rms)
          while (history.length > LIVE_LEVEL_BARS) history.shift()
          setRecorderState({ liveLevels: [...zeroLevels().slice(history.length), ...history] })
        }, 120)
      }
    } catch {
      machinery.audioCtx = null
      machinery.analyser = null
    }
  } catch (error: unknown) {
    releaseCaptureMachinery()
    setRecorderState({
      isRecording: false,
      recordingNodeId: null,
      error: error instanceof Error ? error.message : 'voice-recorder: microphone access denied',
    })
    useGraphStore.getState().setRecordingNode(null)
  }
}

function stopRecording(): void {
  if (!recorderState.isRecording) return
  machinery.recorder?.stop() // onstop → finalizeRecording
}

function cancelRecording(): void {
  if (!recorderState.isRecording) {
    discardPending()
    return
  }
  machinery.discardOnStop = true
  machinery.recorder?.stop()
}

function discardPending(): void {
  const pending = recorderState.pending
  if (pending) URL.revokeObjectURL(pending.blobUrl)
  setRecorderState({ pending: null })
}

function commitPendingRecording(title?: string): MemoId | null {
  const pending = recorderState.pending
  if (!pending) return null
  const defaultTitle = `Voice memo · ${new Date().toLocaleTimeString()}`
  const memoId = useGraphStore
    .getState()
    .addVoiceMemo({
      nodeId: pending.nodeId,
      title: title?.trim() || defaultTitle,
      durationMs: pending.durationMs,
      audioSrc: pending.dataUrl,
    })
  URL.revokeObjectURL(pending.blobUrl)
  setRecorderState({ pending: null })
  return memoId
}

/* ------------------------------------------------------------------ */
/* Playback singleton state (external store)                           */
/* ------------------------------------------------------------------ */

type PlaybackRuntimeState = {
  playingMemoId: MemoId | null
  isPlaybackPaused: boolean
  progress: number
}

let playbackState: PlaybackRuntimeState = { playingMemoId: null, isPlaybackPaused: false, progress: 0 }

const playbackListeners = new Set<() => void>()

function setPlaybackState(patch: Partial<PlaybackRuntimeState>): void {
  playbackState = { ...playbackState, ...patch }
  for (const listener of playbackListeners) listener()
}

function subscribePlayback(listener: () => void): () => void {
  playbackListeners.add(listener)
  return () => {
    playbackListeners.delete(listener)
  }
}

let playbackAudio: HTMLAudioElement | null = null
/** memo id → blob URL created from persisted data: URLs (blob-URL playback). */
const playbackBlobUrlCache = new Map<MemoId, string>()

function teardownPlaybackAudio(): void {
  if (playbackAudio) {
    playbackAudio.pause()
    playbackAudio.onended = null
    playbackAudio.ontimeupdate = null
    playbackAudio.onplay = null
    playbackAudio.onpause = null
    playbackAudio.onerror = null
    playbackAudio = null
  }
}

async function blobUrlForMemo(memo: VoiceMemo): Promise<string | null> {
  if (memo.audioSrc.startsWith('blob:')) return memo.audioSrc
  const cached = playbackBlobUrlCache.get(memo.id)
  if (cached) return cached
  if (!memo.audioSrc.startsWith('data:')) return null
  try {
    const response = await fetch(memo.audioSrc)
    const blob = await response.blob()
    const blobUrl = URL.createObjectURL(blob)
    playbackBlobUrlCache.set(memo.id, blobUrl)
    return blobUrl
  } catch {
    return null
  }
}

function playMemoGlobally(memo: VoiceMemo): void {
  teardownPlaybackAudio()
  setPlaybackState({ playingMemoId: memo.id, isPlaybackPaused: false, progress: 0 })
  void blobUrlForMemo(memo).then((blobUrl) => {
    if (!blobUrl || playbackState.playingMemoId !== memo.id) return
    const audio = new Audio(blobUrl)
    audio.onended = () => setPlaybackState({ playingMemoId: null, isPlaybackPaused: false, progress: 0 })
    audio.ontimeupdate = () => {
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0
      setPlaybackState({ progress: duration > 0 ? Math.min(1, audio.currentTime / duration) : 0 })
    }
    audio.onplay = () => setPlaybackState({ isPlaybackPaused: false })
    audio.onpause = () => setPlaybackState({ isPlaybackPaused: true })
    audio.onerror = () => {
      setPlaybackState({ playingMemoId: null, isPlaybackPaused: false, progress: 0 })
      setRecorderState({ error: 'voice-recorder: playback failed' })
    }
    playbackAudio = audio
    void audio.play().catch(() => {
      setPlaybackState({ playingMemoId: null, isPlaybackPaused: false, progress: 0 })
      setRecorderState({ error: 'voice-recorder: playback blocked by the browser' })
    })
  })
}

function pausePlaybackGlobally(): void {
  playbackAudio?.pause()
}

function resumePlaybackGlobally(): void {
  if (playbackState.playingMemoId && playbackAudio && playbackState.isPlaybackPaused) {
    void playbackAudio.play().catch(() => undefined)
  }
}

function stopPlaybackGlobally(): void {
  teardownPlaybackAudio()
  setPlaybackState({ playingMemoId: null, isPlaybackPaused: false, progress: 0 })
}

/* ------------------------------------------------------------------ */
/* Deterministic 12-bar waveform profile                               */
/* ------------------------------------------------------------------ */

/**
 * Stable 12-bar profile for a memo's CSS visualizer — derived from the memo
 * id, so every component renders the identical waveform without persisting
 * bar data. Values are in 0.15..1.
 */
export function barProfileFor(memoId: string): number[] {
  let seed = fnv1a32(`bars:${memoId}`) || 1
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  return Array.from({ length: LIVE_LEVEL_BARS }, (_, index) => {
    const envelope = 0.55 + 0.45 * Math.abs(Math.sin(index * 0.9 + next()))
    return Math.min(1, Math.max(0.15, (0.3 + next() * 0.7) * envelope))
  })
}

/* ------------------------------------------------------------------ */
/* Hook                                                                */
/* ------------------------------------------------------------------ */

export function useVoiceRecorder(): VoiceRecorderApi {
  const recorder = useSyncExternalStore(subscribeRecorder, () => recorderState)
  const playback = useSyncExternalStore(subscribePlayback, () => playbackState)

  // Only capture is torn down on unmount — global playback (like a dock)
  // intentionally outlives the component that started it.
  useEffect(() => {
    return () => {
      if (recorderState.isRecording) cancelRecording()
    }
  }, [])

  return {
    isSupported: recorder.isSupported,
    isRecording: recorder.isRecording,
    recordingNodeId: recorder.recordingNodeId,
    elapsedMs: recorder.elapsedMs,
    liveLevels: recorder.liveLevels,
    error: recorder.error,
    pending: recorder.pending,
    playingMemoId: playback.playingMemoId,
    isPlaybackPaused: playback.isPlaybackPaused,
    playbackProgress: playback.progress,
    start: startRecording,
    stop: stopRecording,
    cancel: cancelRecording,
    commitPending: commitPendingRecording,
    discardPending,
    playMemo: playMemoGlobally,
    pausePlayback: pausePlaybackGlobally,
    resumePlayback: resumePlaybackGlobally,
    stopPlayback: stopPlaybackGlobally,
  }
}
