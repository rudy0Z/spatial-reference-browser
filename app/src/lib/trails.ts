/**
 * app/src/lib/trails.ts — pure trail-lineage helpers (ADDENDUM B, §B.7
 * Path-Preserving Trails). No React, no store, no Electron: every function
 * here is a pure decision over plain records so `node --test` can exercise
 * the semantics directly (app/tests/trails.test.mjs).
 *
 * Three responsibilities:
 *   1. Provenance capture shape — normalizing an in-page anchor observation
 *      (clicked text/alt, surrounding sentence, scroll offset) into the
 *      bounded `SpawnProvenance` record that rides every spawn edge.
 *   2. Cross-Domain In-Place Navigation Guard — the same/cross decision for
 *      `navigateActiveNode` (§B.7.2): same domain → filmstrip entry;
 *      cross domain → freeze-then-spawn, never a silent overwrite.
 *   3. Trace Rabbit Hole chain walk (§B.7.3) — upstream via `parentUuid` +
 *      incoming spawn/visit edges to the root, downstream to all
 *      descendants, cycle-safe over pathological graphs.
 */
// Explicit .ts extensions on the value import: `node --test` type-stripping
// resolves relative ESM imports literally, while tsc (allowImportingTsExtensions)
// and Vite accept it — the one spelling every consumer agrees on.
import { domainOf } from './types.ts'
import type { EdgeId, GraphEdgeRecord, NodeUuid, SpatialTabNodeRecord } from './types'

/** §B.7.1 — provenance captured at the instant a spawn edge was created. */
export type SpawnProvenance = {
  /** Exact clicked text (or the image's alt when the anchor wraps an image). */
  anchorText: string | null
  /** ≤ 140 chars of the sentence surrounding the clicked anchor. */
  contextSnippet: string | null
  /** Page scroll offset (CSS px) when the click happened; null when unknown. */
  scrollYAtSpawn: number | null
}

/** Hard caps — shared by the capture shape and the Electron preload bridge. */
export const CONTEXT_SNIPPET_MAX = 140
export const ANCHOR_TEXT_MAX = 120
/** §B.7.2 — filmstrip cap for same-domain in-place navigation. */
export const SUB_PAGES_NAV_CAP = 20

/**
 * Normalize a raw in-page anchor observation into `SpawnProvenance`.
 * `contextText` is the surrounding block's text; when the anchor text is
 * known the snippet narrows to the sentence containing it. Returns null when
 * nothing at all was observed (no text, no alt, no scroll).
 */
export function captureAnchorProvenance(raw: {
  anchorText?: string | null
  altText?: string | null
  contextText?: string | null
  scrollY?: number | null
} | null | undefined): SpawnProvenance | null {
  if (!raw || typeof raw !== 'object') return null
  const anchorText = clampText(firstNonEmpty(raw.anchorText, raw.altText), ANCHOR_TEXT_MAX)
  const contextSnippet = clampSentence(firstNonEmpty(raw.contextText), anchorText, CONTEXT_SNIPPET_MAX)
  const scrollYAtSpawn =
    typeof raw.scrollY === 'number' && Number.isFinite(raw.scrollY) ? Math.max(0, Math.round(raw.scrollY)) : null
  if (anchorText === null && contextSnippet === null && scrollYAtSpawn === null) return null
  return { anchorText, contextSnippet, scrollYAtSpawn }
}

/** First non-empty trimmed candidate, else null. */
function firstNonEmpty(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim()
      if (trimmed) return trimmed
    }
  }
  return null
}

/** Trim + hard-cap on one text bound (never mid-word when avoidable). */
function clampText(value: string | null, max: number): string | null {
  if (!value) return null
  if (value.length <= max) return value
  const cut = value.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  // Prefer a clean word boundary; fall back to the hard cut when the first
  // word alone already exceeds the cap.
  return lastSpace > max * 0.6 ? cut.slice(0, lastSpace).trimEnd() : cut.trimEnd()
}

/**
 * Reduce a block's text to ≤ `max` chars. With `anchor` present, prefer the
 * sentence containing it; without one, take the head of the collapsed text.
 * All whitespace collapses first so page formatting never leaks into the
 * snippet.
 */
function clampSentence(blockText: string | null, anchor: string | null, max: number): string | null {
  if (!blockText) return null
  const collapsed = blockText.replace(/\s+/g, ' ').trim()
  if (!collapsed) return null
  // With a known anchor, narrow to the sentence containing it FIRST — the
  // snippet is about the click, not about the block's whole text — then cap.
  if (anchor) {
    const sentence = sentenceContaining(collapsed, anchor)
    if (sentence) {
      if (sentence.length <= max) return sentence
      // A sentence that grew past the cap still yields — windowed around the
      // anchor — rather than falling back to the head of the block.
      return clampText(windowAroundAnchor(sentence, anchor, max), max)
    }
  }
  if (collapsed.length <= max) return collapsed
  return clampText(collapsed, max)
}

/** The full sentence (period/question/exclamation bounded) containing `anchor`. */
function sentenceContaining(text: string, anchor: string): string | null {
  const needle = anchor.replace(/\s+/g, ' ').trim()
  if (!needle) return null
  const at = text.indexOf(needle)
  if (at < 0) return null
  let start = text.lastIndexOf('.', at)
  for (const mark of ['!', '?']) {
    const alt = text.lastIndexOf(mark, at)
    if (alt > start) start = alt
  }
  start = start < 0 ? 0 : start + 1
  let end = text.length
  for (const mark of ['.', '!', '?']) {
    const stop = text.indexOf(mark, at + needle.length)
    if (stop >= 0) end = Math.min(end, stop + 1)
  }
  const sentence = text.slice(start, end).trim()
  return sentence || null
}

/** Center a window of ≤ `max` chars on the anchor's position. */
function windowAroundAnchor(text: string, anchor: string, max: number): string {
  const at = text.indexOf(anchor)
  if (at < 0) return text.slice(0, max)
  const anchorLen = Math.min(anchor.length, max)
  const before = Math.floor((max - anchorLen) / 2)
  const start = Math.max(0, at - before)
  return text.slice(start, start + max)
}

/* ------------------------------------------------------------------ */
/* §B.7.2 — Cross-Domain In-Place Navigation Guard                     */
/* ------------------------------------------------------------------ */

export type InPlaceDecision =
  | { kind: 'same-domain'; domain: string }
  | { kind: 'cross-domain'; fromDomain: string; toDomain: string }

/**
 * The pure guard decision behind `navigateActiveNode`:
 *   same-domain   → append the previous URL/title to `subPages[]` (cap 20);
 *   cross-domain  → freeze the previous node as a hibernated parent at its
 *                   current (x, y) and spawn the new domain as the active
 *                   connected child (`kind: 'spawn'`) — never a silent
 *                   overwrite of a node the graph already knows.
 */
export function decideInPlaceNavigation(nodeDomain: string, newUrl: string): InPlaceDecision {
  const toDomain = domainOf(newUrl)
  // Both sides normalized the same way: a pre-3.4 persisted record may carry
  // a `www.`-prefixed domain; `domainOf` strips it for the incoming URL.
  const fromDomain = (nodeDomain || '').trim().replace(/^www\./, '')
  return fromDomain === toDomain
    ? { kind: 'same-domain', domain: toDomain }
    : { kind: 'cross-domain', fromDomain, toDomain }
}

/* ------------------------------------------------------------------ */
/* §B.7.3 — Trace Rabbit Hole chain walk                               */
/* ------------------------------------------------------------------ */

/**
 * The full chronological research chain for `uuid`:
 *   upstream    — `parentUuid` first, then every INCOMING `spawn`/`visit`
 *                 edge (adoptive lineage), walked to the root;
 *   downstream  — every OUTGOING `spawn`/`visit` edge, closed transitively
 *                 (all descendants).
 * `ghost` edges never join a trail: ghost echoes are suggestions, not
 * history. Cycle-safe: a visited set stops re-entry on pathological graphs
 * (a node that is its own descendant), so the walk always terminates.
 */
export function collectTrailChain(
  uuid: NodeUuid,
  nodes: Record<NodeUuid, SpatialTabNodeRecord>,
  edges: Record<EdgeId, GraphEdgeRecord>,
): Set<NodeUuid> {
  const chain = new Set<NodeUuid>()
  if (!nodes[uuid]) return chain

  /** Adjacency: incoming/outgoing edges of trail-bearing kinds only. */
  const incoming = new Map<NodeUuid, NodeUuid[]>()
  const outgoing = new Map<NodeUuid, NodeUuid[]>()
  for (const edge of Object.values(edges)) {
    if (edge.kind !== 'spawn' && edge.kind !== 'visit') continue
    if (edge.source === edge.target) continue
    if (!nodes[edge.source] || !nodes[edge.target]) continue
    let ins = incoming.get(edge.target)
    if (!ins) {
      ins = []
      incoming.set(edge.target, ins)
    }
    ins.push(edge.source)
    let outs = outgoing.get(edge.source)
    if (!outs) {
      outs = []
      outgoing.set(edge.source, outs)
    }
    outs.push(edge.target)
  }

  const visit = (next: NodeUuid): boolean => {
    if (chain.has(next)) return false
    chain.add(next)
    return true
  }

  visit(uuid)
  // Upstream: parentUuid wins, then adoptive incoming spawn/visit lineage.
  const upstreamStack: NodeUuid[] = [uuid]
  while (upstreamStack.length > 0) {
    const current = upstreamStack.pop() as NodeUuid
    const parents: NodeUuid[] = []
    const parentUuid = nodes[current]?.parentUuid ?? null
    if (parentUuid && nodes[parentUuid]) parents.push(parentUuid)
    for (const source of incoming.get(current) ?? []) parents.push(source)
    for (const parent of parents) {
      if (visit(parent)) upstreamStack.push(parent)
    }
  }
  // Downstream closure: all descendants through outgoing trail edges.
  const downstreamStack: NodeUuid[] = [uuid]
  while (downstreamStack.length > 0) {
    const current = downstreamStack.pop() as NodeUuid
    for (const child of outgoing.get(current) ?? []) {
      if (visit(child)) downstreamStack.push(child)
    }
  }
  return chain
}
