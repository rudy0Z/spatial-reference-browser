/* tslint:disable */
/* eslint-disable */

/**
 * Boids flocking engine (spatial-hash grid). `positions()` returns a flat
 * `[x0, y0, x1, y1, …]` Float64-friendly array for the Canvas 2D renderer.
 */
export class BoidCore {
    free(): void;
    [Symbol.dispose](): void;
    count(): number;
    /**
     * Seeded, deterministic construction. `params_json` may be null for the
     * documented defaults; non-finite world corners are sanitized.
     */
    constructor(seed: number, count: number, min_x: number, min_y: number, max_x: number, max_y: number, params_json: any);
    /**
     * Flat `[x0, y0, x1, y1, …]`.
     */
    positions(): Float64Array;
    /**
     * Click-to-scatter impulse.
     */
    scatter(x: number, y: number, radius: number, impulse: number): void;
    /**
     * One simulation step. `has_cursor == false` ignores the cursor point.
     */
    step(cursor_x: number, cursor_y: number, has_cursor: boolean): void;
}

/**
 * Hybrid force relaxer. `nodes: [{ uuid, x, y, fx?, fy?, isNew, radius }]`
 * (`fx`/`fy` present → locked anchor), `links: [{ source, target, weight }]`
 * with `source`/`target` node indices. `tick()` applies the d3-force v3
 * algorithm (link → charge → collide → homeX/Y → integrate) and returns
 * `{ settled: [{ node, uuid, x, y }], stillRunning, alpha }`.
 */
export class HybridForceCore {
    free(): void;
    [Symbol.dispose](): void;
    alpha(): number;
    constructor(nodes: any, links: any);
    node_count(): number;
    /**
     * Flat positions `[x0, y0, x1, y1, …]` (index = node index).
     */
    positions(): Float64Array;
    /**
     * Re-energize (hook `reheat`).
     */
    reheat(intensity: number): void;
    tick(): any;
}

/**
 * R-tree viewport culler over node card boxes. `id` is the node index the
 * TS wrapper assigns (uuid ↔ index map lives JS-side).
 */
export class SpatialCuller {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Point containment hit-test (smallest card wins).
     */
    hit_test(x: number, y: number): number | undefined;
    len(): number;
    /**
     * Nearest card to a point (nearest-neighbour hit-testing).
     */
    nearest(x: number, y: number): number | undefined;
    constructor();
    /**
     * Ghost keep-out check: does any card strictly overlap the rect?
     */
    overlaps_any(x: number, y: number, width: number, height: number): boolean;
    /**
     * Viewport query with margin — ascending ids of cards intersecting the
     * grown rect.
     */
    query_viewport(min_x: number, min_y: number, max_x: number, max_y: number, margin: number): Uint32Array;
    /**
     * Replace the whole index: `boxes = [{ id, x, y, width, height }, …]`.
     * Non-finite entries are dropped inside the core.
     */
    set_boxes(boxes: any): void;
}

/**
 * Batch subsequence fuzzy search over `{ uuid, title, domain, url,
 * searchQuery?, keywords }` documents — mirrors the palette's tab scoring
 * (title 1.0, domain 0.7, url 0.6, searchQuery 0.7, keywords 0.7), stable
 * descending sort, capped at `limit`.
 */
export function batch_fuzzy_search_js(query: string, docs: any, limit: number): any;

/**
 * Contact-sheet solver — input `nodes: [{ uuid, x, y, isPinned }, …]`,
 * optional `options: { cardWidth?, cardHeight?, pitchAspect?, pitchPaddingY?,
 * maxColumns?, overlapMargin? }`. Output mirrors the TS `MoodboardGridResult`
 * (`positions` is an array of `[uuid, [x, y]]` pairs in the TS insertion
 * order). Bit-identical to the TS solver (golden-tested).
 */
export function moodboard_grid(nodes: any, options: any): any;

/**
 * Batch Ghost Echo scorer — `relevance = 0.55·cosine + 0.30·coVisit +
 * 0.15·recency ≥ 0.78`, strongest first, capped at `limit`. Input
 * `active: { uuid, title, domain, keywords?, searchQuery?, excerpt?,
 * urlHash }`, `candidates: [{ …, edgeWeight, lastVisitedAt, isGhostEcho,
 * isLive, urlHash, urlHashSuppressed }]`. 384-dim cosine uses the same
 * hash embedder as `app/src/lib/embed.ts`.
 */
export function score_ghost_echoes_js(active: any, candidates: any, max_edge_weight: number, now: number, limit: number): any;

/**
 * Route panics to `console.error` (mirrors console_error_panic_hook without
 * the extra dependency).
 */
export function spatial_core_start(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_boidcore_free: (a: number, b: number) => void;
    readonly __wbg_hybridforcecore_free: (a: number, b: number) => void;
    readonly __wbg_spatialculler_free: (a: number, b: number) => void;
    readonly batch_fuzzy_search_js: (a: number, b: number, c: any, d: number) => [number, number, number];
    readonly boidcore_count: (a: number) => number;
    readonly boidcore_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: any) => [number, number, number];
    readonly boidcore_positions: (a: number) => [number, number];
    readonly boidcore_scatter: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly boidcore_step: (a: number, b: number, c: number, d: number) => void;
    readonly hybridforcecore_alpha: (a: number) => number;
    readonly hybridforcecore_new: (a: any, b: any) => [number, number, number];
    readonly hybridforcecore_node_count: (a: number) => number;
    readonly hybridforcecore_positions: (a: number) => [number, number];
    readonly hybridforcecore_reheat: (a: number, b: number) => void;
    readonly hybridforcecore_tick: (a: number) => [number, number, number];
    readonly moodboard_grid: (a: any, b: any) => [number, number, number];
    readonly score_ghost_echoes_js: (a: any, b: any, c: number, d: number, e: number) => [number, number, number];
    readonly spatial_core_start: () => void;
    readonly spatialculler_hit_test: (a: number, b: number, c: number) => number;
    readonly spatialculler_len: (a: number) => number;
    readonly spatialculler_nearest: (a: number, b: number, c: number) => number;
    readonly spatialculler_new: () => number;
    readonly spatialculler_overlaps_any: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly spatialculler_query_viewport: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly spatialculler_set_boxes: (a: number, b: any) => [number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
