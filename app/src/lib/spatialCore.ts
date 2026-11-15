/**
 * app/src/lib/spatialCore.ts — SPATIAL_BROWSER_MASTER_SPEC.md Phase 2 §2: the
 * single seam between the app and the Rust spatial engine
 * (`crates/spatial-core`, compiled to WebAssembly by wasm-pack).
 *
 * Contract:
 *  - `initSpatialCore()` loads the vendored WASM glue
 *    (`./spatial-core-pkg/`, a byte-identical copy of
 *    `crates/spatial-core/pkg/` — re-copy it after a `wasm-pack build`).
 *    When the module or the `.wasm` bytes are unavailable (Node tests,
 *    hardened browsers, load errors) the flag flips to the pure-TS path and
 *    EVERY facade call transparently delegates to the exact-port TS mirrors
 *    in this module — identical inputs, identical outputs, identical
 *    determinism. `useGraphStore.ts`, `SpatialCanvas.tsx` and unit tests all
 *    run through the same facades, so the backend choice is invisible.
 *  - Every WASM call is individually guarded: a runtime failure downgrades
 *    the backend to `'ts'` permanently (self-healing) and re-runs the TS
 *    path — a facade call never throws because WASM did.
 *
 * Subsystem ↔ source-of-truth map (the TS mirrors are exact ports; the Rust
 * modules were ported from these very files and are golden-tested):
 *   cull      → (new; spec Phase 2 item 1a) TS mirror of `cull.rs`
 *   moodboard → `app/src/lib/moodboard.ts` (`computeMoodboardGrid`)
 *   force     → `app/src/hooks/useHybridForceLayout.ts` d3-force config
 *               (the hook itself keeps its fixed contract and its proven
 *               d3-force solver — see the hook header)
 *   search    → `useGraphStore.ts` `fuzzyScore` + tab-scan half of
 *               `selectSearchResults` (useGraphStore.ts:1501-1566)
 *   ghost     → `useGraphStore.ts` `scoreGhostEcho`/`computeGhostEchoCandidates`
 *               (useGraphStore.ts:274-419) over `lib/embed.ts`'s 384-dim
 *               hash embedder
 *   boids     → `crates/spatial-core/src/boids.rs` (spec Phase 2 item 1e;
 *               the Phase 3 new-tab renderer consumes the facade)
 *
 * `*Ts` exports are the always-pure-TS reference implementations — used by
 * `tests/spatialCore.test.mjs` to prove backend parity (WASM vs TS) and by
 * consumers that must not touch the WASM module at all.
 */
// Relative imports carry explicit .ts extensions: the module must load under
// Node's type-stripping for `node --test` (tsconfig `allowImportingTsExtensions`).
import { cosineSimilarity, embedText } from './embed.ts'
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force'
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'
import { computeMoodboardGrid as computeMoodboardGridImpl } from './moodboard.ts'
import type { MoodboardGridOptions, MoodboardGridResult, MoodboardNodeInput } from './moodboard.ts'

/* ------------------------------------------------------------------ */
/* Backend loader                                                      */
/* ------------------------------------------------------------------ */

export type SpatialCoreBackend = 'wasm' | 'ts'
type SpatialCoreInitInput = URL | BufferSource

interface WasmCullerRaw {
  set_boxes(boxes: unknown): void
  query_viewport(minX: number, minY: number, maxX: number, maxY: number, margin: number): Uint32Array
  overlaps_any(x: number, y: number, width: number, height: number): boolean
  hit_test(x: number, y: number): number | undefined
  nearest(x: number, y: number): number | undefined
  len(): number
  free(): void
}

interface WasmForceRaw {
  tick(): unknown
  reheat(intensity: number): void
  positions(): Float64Array
  node_count(): number
  alpha(): number
  free(): void
}

interface WasmBoidRaw {
  step(cursorX: number, cursorY: number, hasCursor: boolean): void
  scatter(x: number, y: number, radius: number, impulse: number): void
  positions(): Float64Array
  count(): number
  free(): void
}

/** Minimal structural view of the wasm-bindgen glue we actually call. */
interface WasmModuleRaw {
  SpatialCuller: new () => WasmCullerRaw
  HybridForceCore: new (nodes: unknown, links: unknown) => WasmForceRaw
  BoidCore: new (
    seed: number,
    count: number,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    params: unknown,
  ) => WasmBoidRaw
  moodboard_grid(nodes: unknown, options: unknown): unknown
  batch_fuzzy_search_js(query: string, docs: unknown, limit: number): unknown
  score_ghost_echoes_js(
    active: unknown,
    candidates: unknown,
    maxEdgeWeight: number,
    now: number,
    limit: number,
  ): unknown
  default(initInput?: SpatialCoreInitInput | { module_or_path: SpatialCoreInitInput }): Promise<unknown>
}

let wasmModule: WasmModuleRaw | null = null
let wasmState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle'
let pendingInit: Promise<SpatialCoreBackend> | null = null

function downgradeToTs(reason: string, error: unknown): void {
  wasmModule = null
  wasmState = 'failed'
  pendingInit = null
  console.warn(`[spatialCore] WASM call failed (${reason}) — downgraded to the pure-TS fallback.`, error)
}

/**
 * Load the WASM module. Idempotent; concurrent callers share one attempt.
 * `initInput` overrides the `.wasm` source — Node tests pass the bytes of
 * `src/lib/spatial-core-pkg/spatial_core_bg.wasm` directly so parity runs
 * without a `file://`-capable `fetch`.
 */
export async function initSpatialCore(initInput?: BufferSource): Promise<SpatialCoreBackend> {
  if (wasmState === 'ready') return 'wasm'
  if (wasmState === 'failed') return 'ts'
  if (pendingInit) return pendingInit
  wasmState = 'loading'
  pendingInit = (async () => {
    try {
      const mod = (await import('./spatial-core-pkg/spatial_core.js')) as unknown as WasmModuleRaw
      const input: SpatialCoreInitInput = initInput ?? new URL('./spatial-core-pkg/spatial_core_bg.wasm', import.meta.url)
      // The glue's recommended call shape ({ module_or_path }) — the bare
      // positional form works but logs a deprecation warning.
      await mod.default({ module_or_path: input })
      wasmModule = mod
      wasmState = 'ready'
      return 'wasm'
    } catch (error) {
      downgradeToTs('module unavailable', error)
      return 'ts'
    }
  })()
  return pendingInit
}

/** Which backend the facades currently route to. */
export function getSpatialCoreBackend(): SpatialCoreBackend {
  return wasmModule !== null ? 'wasm' : 'ts'
}

/* ------------------------------------------------------------------ */
/* cull — R-tree viewport culler (spec Phase 2 item 1a)                */
/* ------------------------------------------------------------------ */

export type CullBoxInput = { id: number; x: number; y: number; width: number; height: number }

export interface SpatialCullerHandle {
  /** Replace the whole index (non-finite / negative-size entries dropped). */
  setBoxes(boxes: readonly CullBoxInput[]): void
  /** Ascending ids of cards strictly intersecting the rect grown by `margin`. */
  queryViewport(minX: number, minY: number, maxX: number, maxY: number, margin: number): number[]
  /** Does any indexed card strictly overlap the rect (touching edges don't)? */
  overlapsAny(x: number, y: number, width: number, height: number): boolean
  /** Smallest-area (then smallest-id) card containing the point, if any. */
  hitTest(x: number, y: number): number | null
  /** Card with the smallest AABB→point distance (ties → smallest id). */
  nearest(x: number, y: number): number | null
  len(): number
  /** Release WASM memory (no-op for the TS mirror). */
  free(): void
}

/** cull.rs `CullBox::is_valid` — finite coordinates, non-negative size. */
function cullBoxIsValid(box: CullBoxInput): boolean {
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height) &&
    box.width >= 0 &&
    box.height >= 0
  )
}

/** cull.rs `CullBox::strict_intersects` — touching edges do NOT count. */
function cullRectStrictIntersects(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by
}

/** Exact TS mirror of `crates/spatial-core/src/cull.rs` (brute-force scan). */
class TsSpatialCuller implements SpatialCullerHandle {
  private boxes: CullBoxInput[] = []

  setBoxes(boxes: readonly CullBoxInput[]): void {
    this.boxes = boxes.filter(cullBoxIsValid)
  }

  queryViewport(minX: number, minY: number, maxX: number, maxY: number, margin: number): number[] {
    if (
      !Number.isFinite(minX) || !Number.isFinite(minY) ||
      !Number.isFinite(maxX) || !Number.isFinite(maxY) ||
      !Number.isFinite(margin) || minX > maxX || minY > maxY
    ) {
      return []
    }
    const gx0 = minX - margin
    const gy0 = minY - margin
    const gx1 = maxX + margin
    const gy1 = maxY + margin
    const ids = new Set<number>()
    for (const box of this.boxes) {
      /* Inclusive envelope intersection — mirrors rstar's
         `locate_in_envelope_intersecting` (touching edges DO count here,
         unlike the strict `rectIntersects` used by `overlapsAny`). */
      if (box.x <= gx1 && box.x + box.width >= gx0 && box.y <= gy1 && box.y + box.height >= gy0) {
        ids.add(box.id)
      }
    }
    return [...ids].sort((a, b) => a - b)
  }

  overlapsAny(x: number, y: number, width: number, height: number): boolean {
    if (
      !Number.isFinite(x) || !Number.isFinite(y) ||
      !Number.isFinite(width) || !Number.isFinite(height) ||
      width < 0 || height < 0
    ) {
      return false
    }
    return this.boxes.some((box) => cullRectStrictIntersects(x, y, width, height, box.x, box.y, box.width, box.height))
  }

  hitTest(x: number, y: number): number | null {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    let bestId: number | null = null
    let bestArea = Number.POSITIVE_INFINITY
    for (const box of this.boxes) {
      const inside = x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height
      if (!inside) continue
      const area = box.width * box.height
      if (area < bestArea || (area === bestArea && (bestId === null || box.id < bestId))) {
        bestId = box.id
        bestArea = area
      }
    }
    return bestId
  }

  nearest(x: number, y: number): number | null {
    let bestId: number | null = null
    let bestD2 = Number.POSITIVE_INFINITY
    for (const box of this.boxes) {
      const dx = Math.max(box.x - x, 0, x - (box.x + box.width))
      const dy = Math.max(box.y - y, 0, y - (box.y + box.height))
      const d2 = dx * dx + dy * dy
      if (d2 < bestD2 || (d2 === bestD2 && (bestId === null || box.id < bestId))) {
        bestId = box.id
        bestD2 = d2
      }
    }
    return bestId
  }

  len(): number {
    return this.boxes.length
  }

  free(): void {
    this.boxes = []
  }
}

/** Always-TS reference culler (tests / guaranteed-no-WASM consumers). */
export function createSpatialCullerTs(): SpatialCullerHandle {
  return new TsSpatialCuller()
}

/** Backend-routed culler — WASM R-tree when ready, TS mirror otherwise.
 * A shadow TS mirror is kept in lockstep with `setBoxes` so a mid-flight WASM
 * failure downgrades to an answer derived from the SAME index, not a fresh one. */
export function createSpatialCuller(): SpatialCullerHandle {
  const wasm = wasmModule
  if (wasm) {
    try {
      const raw = new wasm.SpatialCuller()
      const shadow = createSpatialCullerTs()
      return {
        setBoxes(boxes) {
          shadow.setBoxes(boxes)
          raw.set_boxes([...boxes])
        },
        queryViewport(minX, minY, maxX, maxY, margin) {
          try {
            return [...raw.query_viewport(minX, minY, maxX, maxY, margin)]
          } catch (error) {
            downgradeToTs('query_viewport', error)
            return shadow.queryViewport(minX, minY, maxX, maxY, margin)
          }
        },
        overlapsAny(x, y, width, height) {
          try {
            return raw.overlaps_any(x, y, width, height)
          } catch (error) {
            downgradeToTs('overlaps_any', error)
            return shadow.overlapsAny(x, y, width, height)
          }
        },
        hitTest(x, y) {
          try {
            const hit = raw.hit_test(x, y)
            return hit === undefined ? null : hit
          } catch (error) {
            downgradeToTs('hit_test', error)
            return shadow.hitTest(x, y)
          }
        },
        nearest(x, y) {
          try {
            const hit = raw.nearest(x, y)
            return hit === undefined ? null : hit
          } catch (error) {
            downgradeToTs('nearest', error)
            return shadow.nearest(x, y)
          }
        },
        len() {
          return raw.len()
        },
        free() {
          raw.free()
        },
      }
    } catch (error) {
      downgradeToTs('SpatialCuller::new', error)
    }
  }
  return createSpatialCullerTs()
}

/** Process-wide shared culler. Rebuilt transparently when the backend
 * upgrades (ts → wasm), so late WASM readiness is picked up on the next use. */
let sharedCuller: SpatialCullerHandle | null = null
let sharedCullerBackend: SpatialCoreBackend = 'ts'

export function getSharedSpatialCuller(): SpatialCullerHandle {
  const backend = getSpatialCoreBackend()
  if (!sharedCuller || sharedCullerBackend !== backend) {
    sharedCuller?.free()
    sharedCuller = createSpatialCuller()
    sharedCullerBackend = backend
  }
  return sharedCuller
}

/* ------------------------------------------------------------------ */
/* moodboard — contact-sheet solver (spec Phase 2 item 1b)             */
/* ------------------------------------------------------------------ */

/** Always-TS reference solver (the pure module itself). */
export const computeMoodboardGridTs = computeMoodboardGridImpl

/** Rust result shape: `positions` is `[uuid, [x, y]]` pairs (TS insertion order). */
interface RawMoodboardResult {
  positions: [string, [number, number]][]
  moved: string[]
  unplaced: string[]
  columns: number
  rows: number
  pitchWidth: number
  pitchHeight: number
  cardWidth: number
  cardHeight: number
  origin: [number, number]
  placedCount: number
}

function mapMoodboardResult(raw: RawMoodboardResult): MoodboardGridResult {
  const positions: Record<string, { x: number; y: number }> = {}
  for (const [uuid, point] of raw.positions) {
    positions[uuid] = { x: point[0], y: point[1] }
  }
  return {
    positions,
    moved: raw.moved,
    unplaced: raw.unplaced,
    columns: raw.columns,
    rows: raw.rows,
    pitchWidth: raw.pitchWidth,
    pitchHeight: raw.pitchHeight,
    cardWidth: raw.cardWidth,
    cardHeight: raw.cardHeight,
    origin: { x: raw.origin[0], y: raw.origin[1] },
    placedCount: raw.placedCount,
  }
}

/**
 * Backend-routed contact-sheet solver — signature and result are IDENTICAL
 * to `lib/moodboard.ts` `computeMoodboardGrid` (the Rust module is its exact
 * golden-tested port). `useGraphStore.tidyToMoodboard` consumes this.
 */
export function computeMoodboardGridCore(
  nodes: readonly MoodboardNodeInput[],
  options: MoodboardGridOptions = {},
): MoodboardGridResult {
  const wasm = wasmModule
  if (wasm) {
    try {
      const raw = wasm.moodboard_grid([...nodes], options) as RawMoodboardResult
      return mapMoodboardResult(raw)
    } catch (error) {
      downgradeToTs('moodboard_grid', error)
    }
  }
  return computeMoodboardGridImpl(nodes, options)
}

/* ------------------------------------------------------------------ */
/* force — hybrid relaxer engine (spec Phase 2 item 1b)                */
/* ------------------------------------------------------------------ */

export type ForceNodeCoreInput = {
  uuid: string
  x: number
  y: number
  /** Anchor lock (null when unpinned) — d3 `fx`/`fy`. */
  fx: number | null
  fy: number | null
  isNew: boolean
  radius: number
}

export type ForceLinkCoreInput = { source: string; target: string; weight: number }

export type ForceSettleEvent = { node: number; uuid: string; x: number; y: number }

export type ForceTickReport = {
  /** Satellites that crossed the settle threshold this tick (hook `onSettle`). */
  settled: ForceSettleEvent[]
  /** False once no unsettled satellites remain OR alpha decayed below alphaMin. */
  stillRunning: boolean
  alpha: number
}

export interface HybridForceCoreHandle {
  tick(): ForceTickReport
  reheat(intensity?: number): void
  /** Flat `[x0, y0, x1, y1, …]` (index = input node order). */
  positions(): Float64Array
  nodeCount(): number
  alpha(): number
  free(): void
}

/* Hook constants (useHybridForceLayout.ts:89-93, 226-237) — the Rust port
   (`force.rs` ForceParams) pins the very same numbers. */
const FORCE_ALPHA_MIN = 0.001
const FORCE_SETTLE_VELOCITY_SQ = 0.02
const FORCE_SETTLE_TICKS = 30

interface TsForceSimNode extends SimulationNodeDatum {
  uuid: string
  homeX: number
  homeY: number
  isNew: boolean
  radius: number
  calmTicks: number
}

interface TsForceSimLink extends SimulationLinkDatum<TsForceSimNode> {
  weight: number
}

/** Exact TS mirror of `force.rs` `HybridForceSolver`: the d3-force v3 config
 * of `useHybridForceLayout.ts`, driven manually (`tick()` per step). */
export function createHybridForceCoreTs(
  nodes: readonly ForceNodeCoreInput[],
  links: readonly ForceLinkCoreInput[],
): HybridForceCoreHandle {
  const present = new Set(nodes.map((node) => node.uuid))
  const simNodes: TsForceSimNode[] = nodes.map((node) => ({
    uuid: node.uuid,
    x: node.x,
    y: node.y,
    vx: 0,
    vy: 0,
    fx: node.fx ?? null,
    fy: node.fy ?? null,
    homeX: node.x,
    homeY: node.y,
    isNew: node.isNew,
    radius: node.radius,
    calmTicks: 0,
  }))
  const simLinks: TsForceSimLink[] = links
    .filter((link) => present.has(link.source) && present.has(link.target))
    .map((link) => ({ source: link.source, target: link.target, weight: link.weight }))

  const sim: Simulation<TsForceSimNode, TsForceSimLink> = forceSimulation<TsForceSimNode, TsForceSimLink>(simNodes)
    .force(
      'link',
      forceLink<TsForceSimNode, TsForceSimLink>(simLinks)
        .id((datum) => datum.uuid)
        .distance((link) => 150 + 140 / Math.max(1, link.weight))
        .strength((link) => Math.min(0.12, 0.02 + link.weight * 0.012)),
    )
    .force('charge', forceManyBody<TsForceSimNode>().strength((datum) => (datum.isNew ? -140 : -35)))
    .force('collide', forceCollide<TsForceSimNode>((datum) => datum.radius + 8).strength(0.7).iterations(2))
    .force('homeX', forceX<TsForceSimNode>((datum) => datum.homeX).strength((datum) => (datum.isNew ? 0.05 : 0.55)))
    .force('homeY', forceY<TsForceSimNode>((datum) => datum.homeY).strength((datum) => (datum.isNew ? 0.05 : 0.55)))
    .alphaDecay(0.028)
    .velocityDecay(0.4)
    /* The hook always runs `sim.alpha(0.5).restart()` when the graph changes
       (useHybridForceLayout.ts:275) — d3's factory default alpha is 1. The
       Rust port's ForceParams pins the same 0.5 start. */
    .alpha(0.5)
    .stop()

  const buildReport = (): ForceTickReport => {
    const settled: ForceSettleEvent[] = []
    let stillNew = false
    for (let i = 0; i < simNodes.length; i++) {
      const datum = simNodes[i]
      if (!datum.isNew) continue
      const velocitySq = (datum.vx ?? 0) ** 2 + (datum.vy ?? 0) ** 2
      datum.calmTicks = velocitySq < FORCE_SETTLE_VELOCITY_SQ ? datum.calmTicks + 1 : 0
      if (datum.calmTicks >= FORCE_SETTLE_TICKS) {
        datum.isNew = false
        settled.push({ node: i, uuid: datum.uuid, x: datum.x ?? datum.homeX, y: datum.y ?? datum.homeY })
      } else {
        stillNew = true
      }
    }
    return { settled, stillRunning: stillNew && sim.alpha() > FORCE_ALPHA_MIN, alpha: sim.alpha() }
  }

  return {
    tick() {
      sim.tick()
      return buildReport()
    },
    reheat(intensity = 0.3) {
      sim.alpha(intensity)
    },
    positions() {
      const flat = new Float64Array(simNodes.length * 2)
      for (let i = 0; i < simNodes.length; i++) {
        flat[i * 2] = simNodes[i].x ?? 0
        flat[i * 2 + 1] = simNodes[i].y ?? 0
      }
      return flat
    },
    nodeCount() {
      return simNodes.length
    },
    alpha() {
      return sim.alpha()
    },
    free() {
      sim.stop()
    },
  }
}

interface RawForceTickReport {
  settled: { node: number; uuid: string; x: number; y: number }[]
  stillRunning: boolean
  alpha: number
}

/** Backend-routed force engine. Links reference nodes by uuid; the WASM core
 * receives indices (its `ForceLinkInput` contract). */
export function createHybridForceCore(
  nodes: readonly ForceNodeCoreInput[],
  links: readonly ForceLinkCoreInput[],
): HybridForceCoreHandle {
  const wasm = wasmModule
  if (wasm) {
    try {
      const indexByUuid = new Map(nodes.map((node, index) => [node.uuid, index]))
      const indexedLinks = links
        .filter((link) => indexByUuid.has(link.source) && indexByUuid.has(link.target))
        .map((link) => ({
          source: indexByUuid.get(link.source) as number,
          target: indexByUuid.get(link.target) as number,
          weight: link.weight,
        }))
      const raw = new wasm.HybridForceCore(
        nodes.map((node) => ({
          uuid: node.uuid,
          x: node.x,
          y: node.y,
          fx: node.fx ?? null,
          fy: node.fy ?? null,
          isNew: node.isNew,
          radius: node.radius,
        })),
        indexedLinks,
      )
      return {
        tick() {
          try {
            const report = raw.tick() as RawForceTickReport
            return { settled: report.settled, stillRunning: report.stillRunning, alpha: report.alpha }
          } catch (error) {
            downgradeToTs('force tick', error)
            return TS_FORCE_FALLBACK_REBUILD(nodes, links)
          }
        },
        reheat(intensity = 0.3) {
          raw.reheat(intensity)
        },
        positions() {
          return raw.positions()
        },
        nodeCount() {
          return raw.node_count()
        },
        alpha() {
          return raw.alpha()
        },
        free() {
          raw.free()
        },
      }
    } catch (error) {
      downgradeToTs('HybridForceCore::new', error)
    }
  }
  return createHybridForceCoreTs(nodes, links)
}

/** Worst-case escape hatch when a WASM force call dies mid-flight: rebuild a
 * TS engine from the same inputs so the tick still returns a valid report. */
let TS_FORCE_FALLBACK_REBUILD: (nodes: readonly ForceNodeCoreInput[], links: readonly ForceLinkCoreInput[]) => ForceTickReport =
  (nodes, links) => createHybridForceCoreTs(nodes, links).tick()

/* ------------------------------------------------------------------ */
/* search — batch fuzzy search (spec Phase 2 item 1d)                  */
/* ------------------------------------------------------------------ */

export type SearchDocCoreInput = {
  uuid: string
  title: string
  domain: string
  url: string
  searchQuery?: string | null
  keywords: readonly string[]
}

export type FuzzySearchHit = { uuid: string; score: number; bestText: string }

/**
 * Exact TS mirror of `useGraphStore.ts:1501-1516` `fuzzyScore` (the palette's
 * subsequence scorer; exact substring hits rank highest). Always TS — the
 * Rust module is its byte-exact port (`search.rs fuzzy_score`).
 */
export function fuzzyScore(query: string, text: string): number {
  if (!text) return 0
  const haystack = text.toLowerCase()
  const exact = haystack.indexOf(query)
  if (exact >= 0) return 3 - Math.min(1.5, exact * 0.02)
  let cursor = 0
  let gaps = 0
  for (let i = 0; i < query.length; i++) {
    const found = haystack.indexOf(query[i], cursor)
    if (found === -1) return 0
    gaps += found - cursor
    cursor = found + 1
  }
  return Math.max(0.4, 1.4 - gaps * 0.015)
}

/** Exact TS mirror of the tab-scanning half of `selectSearchResults`
 * (useGraphStore.ts:1536-1566) — per doc best-of title ×1.0, domain ×0.7,
 * url ×0.6, searchQuery ×0.7, each keyword ×0.7; stable descending sort. */
export function batchFuzzySearchTs(
  query: string,
  docs: readonly SearchDocCoreInput[],
  limit: number,
): FuzzySearchHit[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const results: FuzzySearchHit[] = []
  for (const doc of docs) {
    const candidates: Array<{ text: string; weight: number }> = [
      { text: doc.title, weight: 1.0 },
      { text: doc.domain, weight: 0.7 },
      { text: doc.url, weight: 0.6 },
      { text: doc.searchQuery ?? '', weight: 0.7 },
    ]
    for (const keyword of doc.keywords) candidates.push({ text: keyword, weight: 0.7 })
    let best = 0
    let bestText = ''
    for (const candidate of candidates) {
      const score = fuzzyScore(needle, candidate.text) * candidate.weight
      if (score > best) {
        best = score
        bestText = candidate.text
      }
    }
    if (best > 0) results.push({ uuid: doc.uuid, score: best, bestText })
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit)
}

interface RawSearchHit {
  uuid: string
  score: number
  best_text: string
}

/** Backend-routed batch fuzzy search over tab documents. */
export function batchFuzzySearch(
  query: string,
  docs: readonly SearchDocCoreInput[],
  limit: number,
): FuzzySearchHit[] {
  const wasm = wasmModule
  if (wasm) {
    try {
      const raw = wasm.batch_fuzzy_search_js(query, [...docs], limit) as RawSearchHit[]
      return raw.map((hit) => ({ uuid: hit.uuid, score: hit.score, bestText: hit.best_text }))
    } catch (error) {
      downgradeToTs('batch_fuzzy_search', error)
    }
  }
  return batchFuzzySearchTs(query, docs, limit)
}

/* ------------------------------------------------------------------ */
/* ghost — batch Ghost Echo scorer (spec Phase 2 item 1d)              */
/* ------------------------------------------------------------------ */

export type GhostActiveCoreInput = {
  uuid: string
  title: string
  domain: string
  keywords: readonly string[]
  searchQuery?: string | null
  excerpt?: string | null
  /** Numeric `u{fnv1a32(canonicalUrl)}` hash — see `urlHashToNumber`. */
  urlHash: number
}

export type GhostCandidateCoreInput = GhostActiveCoreInput & {
  edgeWeight: number
  lastVisitedAt: number
  isGhostEcho: boolean
  isLive: boolean
  urlHashSuppressed: boolean
}

export type GhostEchoScoreCore = {
  uuid: string
  cosine: number
  coVisit: number
  recency: number
  relevance: number
}

/** GHOST_SCORE_WEIGHTS + GHOST_ECHO_THRESHOLD (useGraphStore.ts:73-82). */
const GHOST_COSINE_WEIGHT = 0.55
const GHOST_CO_VISIT_WEIGHT = 0.3
const GHOST_RECENCY_WEIGHT = 0.15
export const GHOST_ECHO_THRESHOLD = 0.78
/** COLD_ARCHIVE_DAYS (lib/types.ts:313) — the recency decay scale. */
const GHOST_RECENCY_DAYS = 14
const DAY_MS = 86_400_000

/** useGraphStore.ts:262-266 `corpusForNode`. */
function ghostCorpus(node: {
  title: string
  domain: string
  keywords: readonly string[]
  searchQuery?: string | null
  excerpt?: string | null
}): string {
  return [node.title, node.domain, ...node.keywords, node.searchQuery ?? '', (node.excerpt ?? '').slice(0, 400)]
    .join(' ')
    .trim()
}

/** lib/types.ts:407-409 `daysSince`. */
function ghostDaysSince(from: number, now: number): number {
  return Math.max(0, (now - from) / DAY_MS)
}

/** `useGraphStore.urlHashOf` → numeric (the Rust core hashes numerically). */
export function urlHashToNumber(urlHash: string): number {
  return Number.parseInt(urlHash.startsWith('u') ? urlHash.slice(1) : urlHash, 16) >>> 0
}

/** Exact TS mirror of `useGraphStore.ts:274-287` `scoreGhostEcho` +
 * the filter/sort/cap shell of `computeGhostEchoCandidates`
 * (useGraphStore.ts:394-419), over `lib/embed.ts`. */
export function scoreGhostEchoesTs(
  active: GhostActiveCoreInput,
  candidates: readonly GhostCandidateCoreInput[],
  maxEdgeWeightFromActive: number,
  now: number,
  limit: number,
): GhostEchoScoreCore[] {
  const activeEmbedding = embedText(ghostCorpus(active))
  const scored: GhostEchoScoreCore[] = []
  for (const candidate of candidates) {
    if (candidate.uuid === active.uuid) continue
    if (candidate.isGhostEcho || candidate.isLive) continue
    if (candidate.urlHash === active.urlHash || candidate.urlHashSuppressed) continue
    const cosine = cosineSimilarity(activeEmbedding, embedText(ghostCorpus(candidate)))
    const coVisit = maxEdgeWeightFromActive > 0 ? Math.min(1, candidate.edgeWeight / maxEdgeWeightFromActive) : 0
    const recency = Math.exp(-ghostDaysSince(candidate.lastVisitedAt, now) / GHOST_RECENCY_DAYS)
    const relevance =
      GHOST_COSINE_WEIGHT * cosine + GHOST_CO_VISIT_WEIGHT * coVisit + GHOST_RECENCY_WEIGHT * recency
    if (relevance >= GHOST_ECHO_THRESHOLD) {
      scored.push({ uuid: candidate.uuid, cosine, coVisit, recency, relevance })
    }
  }
  return scored.sort((a, b) => b.relevance - a.relevance).slice(0, limit)
}

interface RawGhostScore {
  uuid: string
  cosine: number
  co_visit: number
  recency: number
  relevance: number
}

/** Backend-routed batch Ghost Echo scorer — filters, scoring, threshold,
 * sort and cap all live in the core (Rust mirror of the store's shell). */
export function scoreGhostEchoes(
  active: GhostActiveCoreInput,
  candidates: readonly GhostCandidateCoreInput[],
  maxEdgeWeightFromActive: number,
  now: number,
  limit: number,
): GhostEchoScoreCore[] {
  const wasm = wasmModule
  if (wasm) {
    try {
      const raw = wasm.score_ghost_echoes_js(active, [...candidates], maxEdgeWeightFromActive, now, limit) as RawGhostScore[]
      return raw.map((hit) => ({
        uuid: hit.uuid,
        cosine: hit.cosine,
        coVisit: hit.co_visit,
        recency: hit.recency,
        relevance: hit.relevance,
      }))
    } catch (error) {
      downgradeToTs('score_ghost_echoes', error)
    }
  }
  return scoreGhostEchoesTs(active, candidates, maxEdgeWeightFromActive, now, limit)
}

/* ------------------------------------------------------------------ */
/* boids — flocking engine (spec Phase 2 item 1e)                      */
/* ------------------------------------------------------------------ */

export type BoidWorldInput = { minX: number; minY: number; maxX: number; maxY: number }

export type BoidParamsInput = {
  neighborRadius?: number
  separationRadius?: number
  separationWeight?: number
  alignmentWeight?: number
  cohesionWeight?: number
  maxSpeed?: number
  minSpeed?: number
  maxForce?: number
  cursorScatterRadius?: number
  cursorScatterStrength?: number
  boundsMargin?: number
}

export interface BoidCoreHandle {
  /** One simulation step; `hasCursor == false` ignores the cursor point. */
  step(cursorX: number, cursorY: number, hasCursor: boolean): void
  /** Click-to-scatter impulse. */
  scatter(x: number, y: number, radius: number, impulse: number): void
  /** Flat `[x0, y0, x1, y1, …]`. */
  positions(): Float64Array
  count(): number
  free(): void
}

/** boids.rs `BoidParams::default()` — documented Phase 3-tweakable defaults. */
const BOID_DEFAULTS: Required<BoidParamsInput> = {
  neighborRadius: 55,
  separationRadius: 24,
  separationWeight: 1.5,
  alignmentWeight: 1.0,
  cohesionWeight: 0.8,
  maxSpeed: 3.2,
  minSpeed: 0.35,
  maxForce: 0.07,
  cursorScatterRadius: 120,
  cursorScatterStrength: 1.6,
  boundsMargin: 40,
}

/** boids.rs `lcg` — u32-wrapping LCG, state `s`, seed ≥ 1. */
function boidLcg(seed: number): () => number {
  let state = Math.max(1, seed >>> 0)
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0
    return state / 4294967296
  }
}

function boidLimitForce(x: number, y: number, maxForce: number): [number, number] {
  const magnitude2 = x * x + y * y
  if (magnitude2 === 0 || !Number.isFinite(magnitude2)) return [0, 0]
  const magnitude = Math.sqrt(magnitude2)
  if (magnitude <= maxForce) return [x, y]
  const scale = maxForce / magnitude
  return [x * scale, y * scale]
}

/** Exact TS mirror of `crates/spatial-core/src/boids.rs` (deterministic seeded
 * placement, spatial-hash 3×3 neighborhoods, spicyyoghurt-style steering). */
export function createBoidCoreTs(
  seed: number,
  count: number,
  world: BoidWorldInput,
  params: BoidParamsInput = {},
): BoidCoreHandle {
  const sanitized = (): BoidWorldInput => {
    const { minX, minY, maxX, maxY } = world
    if (
      Number.isFinite(minX) && Number.isFinite(minY) &&
      Number.isFinite(maxX) && Number.isFinite(maxY) &&
      minX < maxX && minY < maxY
    ) {
      return { minX, minY, maxX, maxY }
    }
    return { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  }
  const safeWorld = sanitized()
  const worldWidth = Math.max(1, safeWorld.maxX - safeWorld.minX)
  const worldHeight = Math.max(1, safeWorld.maxY - safeWorld.minY)
  const safeParams: Required<BoidParamsInput> = { ...BOID_DEFAULTS }
  for (const [key, value] of Object.entries(params) as [keyof BoidParamsInput, number][]) {
    if (value !== undefined && Number.isFinite(value)) safeParams[key] = value
  }
  const safeCount = Math.min(4096, Math.max(1, Math.floor(count)))

  interface TsBoid { x: number; y: number; vx: number; vy: number }
  const boids: TsBoid[] = []
  const rng = boidLcg(seed)
  for (let i = 0; i < safeCount; i++) {
    const x = safeWorld.minX + rng() * worldWidth
    const y = safeWorld.minY + rng() * worldHeight
    const angle = rng() * Math.PI * 2
    boids.push({ x, y, vx: Math.cos(angle) * safeParams.maxSpeed * 0.5, vy: Math.sin(angle) * safeParams.maxSpeed * 0.5 })
  }

  const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

  return {
    step(cursorX, cursorY, hasCursor) {
      const params0 = safeParams
      // Spatial hash — cell = neighborRadius, clamped grid like the core.
      const cell = params0.neighborRadius
      const cols = clamp(Math.ceil(worldWidth / cell), 1, 4096)
      const rows = clamp(Math.ceil(worldHeight / cell), 1, 4096)
      const cells: number[][] = new Array(cols * rows)
      for (let i = 0; i < cells.length; i++) cells[i] = []
      const cellOf = (x: number, y: number): [number, number] => [
        clamp(Math.floor((x - safeWorld.minX) / cell), 0, cols - 1),
        clamp(Math.floor((y - safeWorld.minY) / cell), 0, rows - 1),
      ]
      for (let i = 0; i < boids.length; i++) {
        const [cx, cy] = cellOf(boids[i].x, boids[i].y)
        cells[cy * cols + cx].push(i)
      }
      const neighborRadius2 = params0.neighborRadius * params0.neighborRadius
      const separationRadius2 = params0.separationRadius * params0.separationRadius
      const neighbors: number[] = []
      for (let i = 0; i < boids.length; i++) {
        const boid = boids[i]
        const [cx, cy] = cellOf(boid.x, boid.y)
        neighbors.length = 0
        for (let dy = -1; dy <= 1; dy++) {
          const ny = cy + dy
          if (ny < 0 || ny >= rows) continue
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx
            if (nx < 0 || nx >= cols) continue
            for (const index of cells[ny * cols + nx]) neighbors.push(index)
          }
        }
        neighbors.sort((a, b) => a - b)
        let sepX = 0
        let sepY = 0
        let alignX = 0
        let alignY = 0
        let coheX = 0
        let coheY = 0
        let neighborCount = 0
        for (const j of neighbors) {
          if (j === i) continue
          const other = boids[j]
          const dx = boid.x - other.x
          const dy = boid.y - other.y
          const dist2 = dx * dx + dy * dy
          if (dist2 > neighborRadius2) continue
          neighborCount += 1
          alignX += other.vx
          alignY += other.vy
          coheX += other.x
          coheY += other.y
          if (dist2 < separationRadius2 && dist2 > 0) {
            const dist = Math.sqrt(dist2)
            const falloff = 1 - dist / params0.separationRadius
            const inv = 1 / dist
            sepX += dx * inv * falloff
            sepY += dy * inv * falloff
          } else if (dist2 === 0) {
            const angle = i * 2.399963229728653 // golden angle (core-identical)
            sepX += Math.cos(angle)
            sepY += Math.sin(angle)
          }
        }
        let fx = 0
        let fy = 0
        const [sx, sy] = boidLimitForce(sepX, sepY, params0.maxForce)
        fx += sx * params0.separationWeight
        fy += sy * params0.separationWeight
        if (neighborCount > 0) {
          const countInv = 1 / neighborCount
          const [ax, ay] = boidLimitForce(alignX * countInv, alignY * countInv, params0.maxForce)
          fx += ax * params0.alignmentWeight
          fy += ay * params0.alignmentWeight
          const [cx2, cy2] = boidLimitForce(coheX * countInv - boid.x, coheY * countInv - boid.y, params0.maxForce)
          fx += cx2 * params0.cohesionWeight
          fy += cy2 * params0.cohesionWeight
        }
        if (hasCursor && Number.isFinite(cursorX) && Number.isFinite(cursorY)) {
          const dx = boid.x - cursorX
          const dy = boid.y - cursorY
          const dist2 = dx * dx + dy * dy
          if (dist2 < params0.cursorScatterRadius * params0.cursorScatterRadius && dist2 > 0) {
            const dist = Math.sqrt(dist2)
            const falloff = 1 - dist / params0.cursorScatterRadius
            const push = params0.cursorScatterStrength * falloff * falloff
            fx += (dx / dist) * push
            fy += (dy / dist) * push
          }
        }
        const margin = params0.boundsMargin
        if (margin > 0) {
          if (boid.x < safeWorld.minX + margin) fx += (1 - (boid.x - safeWorld.minX) / margin) * params0.maxForce * 2
          if (boid.x > safeWorld.maxX - margin) fx -= (1 - (safeWorld.maxX - boid.x) / margin) * params0.maxForce * 2
          if (boid.y < safeWorld.minY + margin) fy += (1 - (boid.y - safeWorld.minY) / margin) * params0.maxForce * 2
          if (boid.y > safeWorld.maxY - margin) fy -= (1 - (safeWorld.maxY - boid.y) / margin) * params0.maxForce * 2
        }
        boid.vx += fx
        boid.vy += fy
        const speed2 = boid.vx * boid.vx + boid.vy * boid.vy
        if (speed2 > params0.maxSpeed * params0.maxSpeed) {
          const scale = params0.maxSpeed / Math.sqrt(speed2)
          boid.vx *= scale
          boid.vy *= scale
        } else if (speed2 < params0.minSpeed * params0.minSpeed && speed2 > 0) {
          const scale = params0.minSpeed / Math.sqrt(speed2)
          boid.vx *= scale
          boid.vy *= scale
        }
        boid.x += boid.vx
        boid.y += boid.vy
        boid.x = clamp(boid.x, safeWorld.minX, safeWorld.maxX)
        boid.y = clamp(boid.y, safeWorld.minY, safeWorld.maxY)
      }
      // no-NaN law (boids.rs sanitize pass)
      for (const boid of boids) {
        if (!Number.isFinite(boid.x)) boid.x = (safeWorld.minX + safeWorld.maxX) / 2
        if (!Number.isFinite(boid.y)) boid.y = (safeWorld.minY + safeWorld.maxY) / 2
        if (!Number.isFinite(boid.vx)) boid.vx = 0
        if (!Number.isFinite(boid.vy)) boid.vy = 0
      }
    },
    scatter(x, y, radius, impulse) {
      if (
        !Number.isFinite(x) || !Number.isFinite(y) ||
        !Number.isFinite(radius) || !Number.isFinite(impulse) || radius <= 0
      ) {
        return
      }
      for (const boid of boids) {
        const dx = boid.x - x
        const dy = boid.y - y
        const dist2 = dx * dx + dy * dy
        if (dist2 < radius * radius && dist2 > 0) {
          const dist = Math.sqrt(dist2)
          const falloff = 1 - dist / radius
          const kick = impulse * falloff
          boid.vx += (dx / dist) * kick
          boid.vy += (dy / dist) * kick
        }
      }
    },
    positions() {
      const flat = new Float64Array(boids.length * 2)
      for (let i = 0; i < boids.length; i++) {
        flat[i * 2] = boids[i].x
        flat[i * 2 + 1] = boids[i].y
      }
      return flat
    },
    count() {
      return boids.length
    },
    free() {
      boids.length = 0
    },
  }
}

/** Backend-routed boids engine. */
export function createBoidCore(
  seed: number,
  count: number,
  world: BoidWorldInput,
  params: BoidParamsInput = {},
): BoidCoreHandle {
  const wasm = wasmModule
  if (wasm) {
    try {
      /* The Rust BoidParams has no serde field defaults — an empty or partial
         object would fail deserialization, so always send the fully merged
         parameter object (defaults overridden by the caller's finite values). */
      const fullParams: Required<BoidParamsInput> = { ...BOID_DEFAULTS }
      for (const [key, value] of Object.entries(params) as [keyof BoidParamsInput, number][]) {
        if (value !== undefined && Number.isFinite(value)) fullParams[key] = value
      }
      const raw = new wasm.BoidCore(
        seed >>> 0,
        Math.floor(count),
        world.minX,
        world.minY,
        world.maxX,
        world.maxY,
        fullParams,
      )
      return {
        step(cursorX, cursorY, hasCursor) {
          raw.step(cursorX, cursorY, hasCursor)
        },
        scatter(x, y, radius, impulse) {
          raw.scatter(x, y, radius, impulse)
        },
        positions() {
          return raw.positions()
        },
        count() {
          return raw.count()
        },
        free() {
          raw.free()
        },
      }
    } catch (error) {
      downgradeToTs('BoidCore::new', error)
    }
  }
  return createBoidCoreTs(seed, count, world, params)
}
