import type { NodeUuid, SpatialTabNodeRecord } from './types'

/**
 * §5.2 — maximum simultaneously *live* (attached-renderer) tabs. Everything
 * else hibernates to 0 MB and keeps its node, position and edges.
 */
export const LIVE_POOL_LIMIT = 5

/** §5.3 / §7.7 — audible tabs, pinned anchors and the recording node never auto-hibernate. */
export function isNodeImmune(node: SpatialTabNodeRecord, recordingNodeId: NodeUuid | null): boolean {
  return node.isAudible || node.isPinned || node.uuid === recordingNodeId
}

export type LivePoolResult = {
  nodes: Record<NodeUuid, SpatialTabNodeRecord>
  evicted: SpatialTabNodeRecord | null
}

/**
 * §5.2 — LRU eviction for the strict live pool. Skips the whole sweep while
 * a voice note records (§5.3) and never evicts the active node or an immune
 * tab. Pure and Electron/React-free so it is fixture-testable (Blanc's
 * pure-module culture).
 *
 * Partial-eviction contract (master spec Phase 1.5): when at least one tab
 * was hibernated, the hibernated map and that tab are returned even if
 * immune tabs keep the pool nominally over budget. Reverting to the input
 * map in that case used to silently resurrect evicted renderers AND leave
 * the pool over the limit — the store never learned an eviction happened.
 */
export function enforceLivePool(
  nodes: Record<NodeUuid, SpatialTabNodeRecord>,
  recordingNodeId: NodeUuid | null,
  activeUuid: NodeUuid | null,
): LivePoolResult {
  const live = Object.values(nodes).filter((node) => node.ramState === 'live')
  if (live.length <= LIVE_POOL_LIMIT || recordingNodeId) return { nodes, evicted: null }
  const ordered = [...live].sort((a, b) => a.lastVisitedAt - b.lastVisitedAt)
  let excess = live.length - LIVE_POOL_LIMIT
  let evicted: SpatialTabNodeRecord | null = null
  const next = { ...nodes }
  for (const candidate of ordered) {
    if (excess <= 0) break
    if (candidate.uuid === activeUuid) continue
    if (isNodeImmune(candidate, recordingNodeId)) continue
    const hibernated: SpatialTabNodeRecord = { ...candidate, ramState: 'hibernated', ramMb: 0, isLoading: false }
    next[candidate.uuid] = hibernated
    if (!evicted) evicted = hibernated
    excess -= 1
  }
  if (evicted !== null) return { nodes: next, evicted }
  return { nodes, evicted: null }
}
