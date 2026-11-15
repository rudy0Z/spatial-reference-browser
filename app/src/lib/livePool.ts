import type { NodeUuid, SpatialTabNodeRecord } from './types'

/**
 * §B.6 (ADDENDUM B) — Working-Session Guardrails. The hard `LIVE_POOL_LIMIT
 * = 5` is replaced by a user-configurable `performanceGuardrail`. Everything
 * here stays a pure, Electron/React-free module so it is fixture-testable
 * (Blanc's pure-module culture).
 *
 * - `maxLiveSessionTabs` — maximum simultaneously *live* (attached-renderer)
 *   tabs. Everything else hibernates to 0 MB and keeps its node, position
 *   and edges. Default 25; user range 5..100 or `'unlimited'`.
 * - `idleHibernateMinutes` — a live tab untouched this long parks itself to
 *   0 MB (15/30/60 or `'never'`). Default 60.
 * - `ramCeilingMb?` — optional: past this total live-RAM budget the LRU
 *   sweep evicts until back under the ceiling.
 */

export type MaxLiveSessionTabs = number | 'unlimited'
export type IdleHibernateMinutes = 15 | 30 | 60 | 'never'

export type PerformanceGuardrail = {
  maxLiveSessionTabs: MaxLiveSessionTabs
  idleHibernateMinutes: IdleHibernateMinutes
  ramCeilingMb?: number
}

/** §B.6 defaults — 25 live tabs, 60-minute idle park, no RAM ceiling. */
export const DEFAULT_PERFORMANCE_GUARDRAIL: PerformanceGuardrail = {
  maxLiveSessionTabs: 25,
  idleHibernateMinutes: 60,
}

/** User-configurable bounds for `maxLiveSessionTabs` (§B.6: `5..100`). */
export const MAX_LIVE_TABS_MIN = 5
export const MAX_LIVE_TABS_MAX = 100

/**
 * Sanitize a (possibly partial / persisted / user-typed) guardrail patch into
 * a full valid record. Unknown or out-of-range values fall back to the
 * canonical defaults — the guardrail is a promise to the user, never a
 * way for bad data to disable the pool.
 */
export function normalizeGuardrail(raw: Partial<PerformanceGuardrail> | null | undefined): PerformanceGuardrail {
  const next: PerformanceGuardrail = { ...DEFAULT_PERFORMANCE_GUARDRAIL }
  if (!raw) return next

  if (raw.maxLiveSessionTabs === 'unlimited') {
    next.maxLiveSessionTabs = 'unlimited'
  } else if (typeof raw.maxLiveSessionTabs === 'number' && Number.isFinite(raw.maxLiveSessionTabs)) {
    next.maxLiveSessionTabs = Math.min(MAX_LIVE_TABS_MAX, Math.max(MAX_LIVE_TABS_MIN, Math.round(raw.maxLiveSessionTabs)))
  }

  if (raw.idleHibernateMinutes === 'never') {
    next.idleHibernateMinutes = 'never'
  } else if (raw.idleHibernateMinutes === 15 || raw.idleHibernateMinutes === 30 || raw.idleHibernateMinutes === 60) {
    next.idleHibernateMinutes = raw.idleHibernateMinutes
  }

  if (typeof raw.ramCeilingMb === 'number' && Number.isFinite(raw.ramCeilingMb) && raw.ramCeilingMb > 0) {
    next.ramCeilingMb = Math.round(raw.ramCeilingMb)
  }
  return next
}

/** §B.6 — a tab that just paused audio keeps its immunity for this long. */
export const AUDIO_PAUSE_DEBOUNCE_MS = 2_500

/**
 * §5.3 / §7.7 / §B.6 — audible tabs (plus a 2.5 s pause debounce so a track
 * gap never gets a tab killed mid-listen), pinned anchors and the recording
 * node are never auto-hibernated "behind the user's back".
 *
 * `audiblePausedAt` maps uuid → wall-clock timestamp of the audio pause;
 * `now` defaults to `Date.now()`. Both optional so existing callers and
 * fixtures keep working unchanged.
 */
export function isNodeImmune(
  node: SpatialTabNodeRecord,
  recordingNodeId: NodeUuid | null,
  audiblePausedAt?: Record<NodeUuid, number>,
  now?: number,
): boolean {
  if (node.isAudible || node.isPinned || node.uuid === recordingNodeId) return true
  if (audiblePausedAt) {
    const pausedAt = audiblePausedAt[node.uuid]
    if (typeof pausedAt === 'number' && (now ?? Date.now()) - pausedAt < AUDIO_PAUSE_DEBOUNCE_MS) return true
  }
  return false
}

export type LivePoolResult = {
  nodes: Record<NodeUuid, SpatialTabNodeRecord>
  evicted: SpatialTabNodeRecord | null
}

/**
 * §5.2 / §B.6 — LRU eviction for the live pool, bounded by the user's
 * `maxLiveSessionTabs` guardrail instead of the old hard 5. Skips the whole
 * sweep while a voice note records (§5.3) and never evicts the active node
 * or an immune tab.
 *
 * Partial-eviction contract (master spec Phase 1.5, kept verbatim): when at
 * least one tab was hibernated, the hibernated map and that tab are returned
 * even if immune tabs keep the pool nominally over budget. Reverting to the
 * input map in that case used to silently resurrect evicted renderers AND
 * leave the pool over the limit — the store never learned an eviction
 * happened.
 */
export function enforceLivePool(
  nodes: Record<NodeUuid, SpatialTabNodeRecord>,
  recordingNodeId: NodeUuid | null,
  activeUuid: NodeUuid | null,
  guardrail: PerformanceGuardrail = DEFAULT_PERFORMANCE_GUARDRAIL,
  audiblePausedAt?: Record<NodeUuid, number>,
): LivePoolResult {
  if (guardrail.maxLiveSessionTabs === 'unlimited') return { nodes, evicted: null }
  const live = Object.values(nodes).filter((node) => node.ramState === 'live')
  if (live.length <= guardrail.maxLiveSessionTabs || recordingNodeId) return { nodes, evicted: null }
  const ordered = [...live].sort((a, b) => a.lastVisitedAt - b.lastVisitedAt)
  let excess = live.length - guardrail.maxLiveSessionTabs
  let evicted: SpatialTabNodeRecord | null = null
  const next = { ...nodes }
  for (const candidate of ordered) {
    if (excess <= 0) break
    if (candidate.uuid === activeUuid) continue
    if (isNodeImmune(candidate, recordingNodeId, audiblePausedAt)) continue
    const hibernated: SpatialTabNodeRecord = { ...candidate, ramState: 'hibernated', ramMb: 0, isLoading: false }
    next[candidate.uuid] = hibernated
    if (!evicted) evicted = hibernated
    excess -= 1
  }
  if (evicted !== null) return { nodes: next, evicted }
  return { nodes, evicted: null }
}

/**
 * §B.6 optional RAM ceiling: when total live-RAM exceeds `ceilingMb`, evict
 * LRU non-immune live tabs until back under it (or until only immune/active
 * tabs remain — the partial-eviction contract applies exactly as above).
 */
export function enforceRamCeiling(
  nodes: Record<NodeUuid, SpatialTabNodeRecord>,
  recordingNodeId: NodeUuid | null,
  activeUuid: NodeUuid | null,
  ceilingMb: number,
  audiblePausedAt?: Record<NodeUuid, number>,
): LivePoolResult {
  if (!Number.isFinite(ceilingMb) || ceilingMb <= 0) return { nodes, evicted: null }
  const live = Object.values(nodes).filter((node) => node.ramState === 'live')
  const totalMb = live.reduce((sum, node) => sum + node.ramMb, 0)
  if (totalMb <= ceilingMb || recordingNodeId) return { nodes, evicted: null }
  const ordered = [...live].sort((a, b) => a.lastVisitedAt - b.lastVisitedAt)
  let overBy = totalMb - ceilingMb
  let evicted: SpatialTabNodeRecord | null = null
  const next = { ...nodes }
  for (const candidate of ordered) {
    if (overBy <= 0) break
    if (candidate.uuid === activeUuid) continue
    if (isNodeImmune(candidate, recordingNodeId, audiblePausedAt)) continue
    const hibernated: SpatialTabNodeRecord = { ...candidate, ramState: 'hibernated', ramMb: 0, isLoading: false }
    next[candidate.uuid] = hibernated
    if (!evicted) evicted = hibernated
    overBy -= candidate.ramMb
  }
  if (evicted !== null) return { nodes: next, evicted }
  return { nodes, evicted: null }
}

export type IdleSweepResult = {
  nodes: Record<NodeUuid, SpatialTabNodeRecord>
  /** How many live tabs were parked to 0 MB by this sweep. */
  parked: number
}

/**
 * §B.6 idle hibernation: live tabs whose `lastVisitedAt` is older than
 * `idleMinutes` park to 0 MB. The active node and immune tabs (pinned /
 * audible + pause debounce / recording) are never touched. `'never'` or a
 * non-positive window is a no-op returning the input map untouched.
 */
export function hibernateIdleNodes(
  nodes: Record<NodeUuid, SpatialTabNodeRecord>,
  idleMinutes: IdleHibernateMinutes,
  now: number,
  activeUuid: NodeUuid | null,
  recordingNodeId: NodeUuid | null,
  audiblePausedAt?: Record<NodeUuid, number>,
): IdleSweepResult {
  if (idleMinutes === 'never' || !(idleMinutes > 0) || recordingNodeId) return { nodes, parked: 0 }
  const cutoff = now - idleMinutes * 60_000
  let parked = 0
  const next = { ...nodes }
  for (const node of Object.values(nodes)) {
    if (node.ramState !== 'live') continue
    if (node.uuid === activeUuid) continue
    if (isNodeImmune(node, recordingNodeId, audiblePausedAt, now)) continue
    if (node.lastVisitedAt > cutoff) continue
    next[node.uuid] = { ...node, ramState: 'hibernated', ramMb: 0, isLoading: false }
    parked += 1
  }
  if (parked === 0) return { nodes, parked: 0 }
  return { nodes: next, parked }
}
