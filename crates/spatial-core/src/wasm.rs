//! WASM surface (`wasm-pack build --target web --features wasm`) — thin
//! serde-wasm-bindgen wrappers around the pure modules. All heavy math lives
//! in the platform-free modules (`cull`, `moodboard`, `force`, `search`,
//! `boids`) so the Node/TS fallback and these bindings share one algorithm.
//!
//! Loading shape (produced by wasm-pack into `pkg/`):
//! ```js
//! import init, { SpatialCuller, moodboard_grid, HybridForceCore,
//!                batch_fuzzy_search, score_ghost_echoes, BoidCore }
//!   from './pkg/spatial_core.js';
//! await init(); // loads spatial_core_bg.wasm next to the JS glue
//! ```
//!
//! Every binding returns `Result<JsValue, JsValue>` where the error is a
//! string — no panics cross the boundary (wasm-bindgen would trap otherwise).

use serde_wasm_bindgen::{from_value, to_value};
use wasm_bindgen::prelude::*;

use crate::boids::{BoidParams, BoidSim, BoidWorld};
use crate::cull::{CullBox, ViewportCuller};
use crate::force::{ForceLinkInput, ForceNodeInput, HybridForceSolver};
use crate::moodboard::{compute_moodboard_grid, MoodboardGridOptions, MoodboardNodeInput};
use crate::search::{batch_fuzzy_search, score_ghost_echoes, GhostCandidate, SearchDoc};

/// Route panics to `console.error` (mirrors console_error_panic_hook without
/// the extra dependency).
#[wasm_bindgen(start)]
pub fn spatial_core_start() {
    std::panic::set_hook(Box::new(|info| {
        spatial_core_console_error(&format!("spatial-core panic: {info}"));
    }));
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn error(s: &str);
}

fn spatial_core_console_error(message: &str) {
    error(message);
}

fn to_js<T: serde::Serialize>(value: T) -> Result<JsValue, JsValue> {
    to_value(&value).map_err(|e| JsValue::from_str(&format!("serialize error: {e}")))
}

// ---------------------------------------------------------------- culler

/// R-tree viewport culler over node card boxes. `id` is the node index the
/// TS wrapper assigns (uuid ↔ index map lives JS-side).
#[wasm_bindgen]
pub struct SpatialCuller {
    inner: ViewportCuller,
}

#[wasm_bindgen]
impl SpatialCuller {
    #[wasm_bindgen(constructor)]
    pub fn new() -> SpatialCuller {
        SpatialCuller { inner: ViewportCuller::new() }
    }

    /// Replace the whole index: `boxes = [{ id, x, y, width, height }, …]`.
    /// Non-finite entries are dropped inside the core.
    pub fn set_boxes(&mut self, boxes: JsValue) -> Result<(), JsValue> {
        let parsed: Vec<CullBox> = from_value(boxes).map_err(|e| JsValue::from_str(&format!("set_boxes: {e}")))?;
        self.inner = ViewportCuller::from_boxes(parsed);
        Ok(())
    }

    /// Viewport query with margin — ascending ids of cards intersecting the
    /// grown rect.
    pub fn query_viewport(&mut self, min_x: f64, min_y: f64, max_x: f64, max_y: f64, margin: f64) -> Vec<u32> {
        self.inner.query_viewport(min_x, min_y, max_x, max_y, margin)
    }

    /// Nearest card to a point (nearest-neighbour hit-testing).
    pub fn nearest(&mut self, x: f64, y: f64) -> Option<u32> {
        self.inner.nearest(x, y).map(|(id, _)| id)
    }

    /// Point containment hit-test (smallest card wins).
    pub fn hit_test(&mut self, x: f64, y: f64) -> Option<u32> {
        self.inner.hit_test(x, y)
    }

    /// Ghost keep-out check: does any card strictly overlap the rect?
    pub fn overlaps_any(&self, x: f64, y: f64, width: f64, height: f64) -> bool {
        self.inner.overlaps_any(x, y, width, height)
    }

    pub fn len(&self) -> usize {
        self.inner.len()
    }
}

// ------------------------------------------------------------ moodboard

/// Contact-sheet solver — input `nodes: [{ uuid, x, y, isPinned }, …]`,
/// optional `options: { cardWidth?, cardHeight?, pitchAspect?, pitchPaddingY?,
/// maxColumns?, overlapMargin? }`. Output mirrors the TS `MoodboardGridResult`
/// (`positions` is an array of `[uuid, [x, y]]` pairs in the TS insertion
/// order). Bit-identical to the TS solver (golden-tested).
#[wasm_bindgen]
pub fn moodboard_grid(nodes: JsValue, options: JsValue) -> Result<JsValue, JsValue> {
    let parsed_nodes: Vec<MoodboardNodeInput> = from_value(nodes).map_err(|e| JsValue::from_str(&format!("moodboard_grid nodes: {e}")))?;
    let parsed_options: MoodboardGridOptions = if options.is_undefined() || options.is_null() {
        MoodboardGridOptions::default()
    } else {
        from_value(options).map_err(|e| JsValue::from_str(&format!("moodboard_grid options: {e}")))?
    };
    to_js(compute_moodboard_grid(&parsed_nodes, &parsed_options))
}

// ---------------------------------------------------------------- force

/// Hybrid force relaxer. `nodes: [{ uuid, x, y, fx?, fy?, isNew, radius }]`
/// (`fx`/`fy` present → locked anchor), `links: [{ source, target, weight }]`
/// with `source`/`target` node indices. `tick()` applies the d3-force v3
/// algorithm (link → charge → collide → homeX/Y → integrate) and returns
/// `{ settled: [{ node, uuid, x, y }], stillRunning, alpha }`.
#[wasm_bindgen]
pub struct HybridForceCore {
    inner: HybridForceSolver,
}

#[wasm_bindgen]
impl HybridForceCore {
    #[wasm_bindgen(constructor)]
    pub fn new(nodes: JsValue, links: JsValue) -> Result<HybridForceCore, JsValue> {
        let parsed_nodes: Vec<ForceNodeInput> = from_value(nodes).map_err(|e| JsValue::from_str(&format!("force nodes: {e}")))?;
        let parsed_links: Vec<ForceLinkInput> = from_value(links).map_err(|e| JsValue::from_str(&format!("force links: {e}")))?;
        Ok(HybridForceCore { inner: HybridForceSolver::new(parsed_nodes, &parsed_links) })
    }

    pub fn tick(&mut self) -> Result<JsValue, JsValue> {
        to_js(self.inner.tick())
    }

    /// Re-energize (hook `reheat`).
    pub fn reheat(&mut self, intensity: f64) {
        self.inner.reheat(intensity);
    }

    /// Flat positions `[x0, y0, x1, y1, …]` (index = node index).
    pub fn positions(&self) -> Vec<f64> {
        let (xs, ys) = self.inner.positions();
        let mut flat = Vec::with_capacity(xs.len() * 2);
        for i in 0..xs.len() {
            flat.push(xs[i]);
            flat.push(ys[i]);
        }
        flat
    }

    pub fn node_count(&self) -> usize {
        self.inner.node_count()
    }

    pub fn alpha(&self) -> f64 {
        self.inner.alpha()
    }
}

// --------------------------------------------------------------- search

/// Batch subsequence fuzzy search over `{ uuid, title, domain, url,
/// searchQuery?, keywords }` documents — mirrors the palette's tab scoring
/// (title 1.0, domain 0.7, url 0.6, searchQuery 0.7, keywords 0.7), stable
/// descending sort, capped at `limit`.
#[wasm_bindgen]
pub fn batch_fuzzy_search_js(query: &str, docs: JsValue, limit: usize) -> Result<JsValue, JsValue> {
    let parsed: Vec<SearchDoc> = from_value(docs).map_err(|e| JsValue::from_str(&format!("search docs: {e}")))?;
    to_js(batch_fuzzy_search(query, &parsed, limit))
}

/// Active-node descriptor for the Ghost Echo batch scorer.
#[derive(serde::Serialize, serde::Deserialize)]
struct ActiveNode {
    uuid: String,
    title: String,
    domain: String,
    #[serde(default)]
    keywords: Vec<String>,
    #[serde(rename = "searchQuery", default)]
    search_query: Option<String>,
    #[serde(default)]
    excerpt: Option<String>,
    #[serde(rename = "urlHash")]
    url_hash: u32,
}

/// Batch Ghost Echo scorer — `relevance = 0.55·cosine + 0.30·coVisit +
/// 0.15·recency ≥ 0.78`, strongest first, capped at `limit`. Input
/// `active: { uuid, title, domain, keywords?, searchQuery?, excerpt?,
/// urlHash }`, `candidates: [{ …, edgeWeight, lastVisitedAt, isGhostEcho,
/// isLive, urlHash, urlHashSuppressed }]`. 384-dim cosine uses the same
/// hash embedder as `app/src/lib/embed.ts`.
#[wasm_bindgen]
pub fn score_ghost_echoes_js(active: JsValue, candidates: JsValue, max_edge_weight: f64, now: f64, limit: usize) -> Result<JsValue, JsValue> {
    let active_node: ActiveNode = from_value(active).map_err(|e| JsValue::from_str(&format!("ghost active: {e}")))?;
    let parsed: Vec<GhostCandidate> = from_value(candidates).map_err(|e| JsValue::from_str(&format!("ghost candidates: {e}")))?;
    to_js(score_ghost_echoes(
        &active_node.uuid,
        &active_node.title,
        &active_node.domain,
        &active_node.keywords,
        active_node.search_query.as_deref(),
        active_node.excerpt.as_deref(),
        active_node.url_hash,
        max_edge_weight,
        &parsed,
        now,
        limit,
    ))
}

// ---------------------------------------------------------------- boids

/// Boids flocking engine (spatial-hash grid). `positions()` returns a flat
/// `[x0, y0, x1, y1, …]` Float64-friendly array for the Canvas 2D renderer.
#[wasm_bindgen]
pub struct BoidCore {
    inner: BoidSim,
}

#[wasm_bindgen]
impl BoidCore {
    /// Seeded, deterministic construction. `params_json` may be null for the
    /// documented defaults; non-finite world corners are sanitized.
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32, count: usize, min_x: f64, min_y: f64, max_x: f64, max_y: f64, params_json: JsValue) -> Result<BoidCore, JsValue> {
        let params: BoidParams = if params_json.is_undefined() || params_json.is_null() {
            BoidParams::default()
        } else {
            from_value(params_json).map_err(|e| JsValue::from_str(&format!("boid params: {e}")))?
        };
        Ok(BoidCore {
            inner: BoidSim::new(seed, count, BoidWorld { min_x, min_y, max_x, max_y }, params),
        })
    }

    /// One simulation step. `has_cursor == false` ignores the cursor point.
    pub fn step(&mut self, cursor_x: f64, cursor_y: f64, has_cursor: bool) {
        self.inner.step(if has_cursor { Some((cursor_x, cursor_y)) } else { None });
    }

    /// Click-to-scatter impulse.
    pub fn scatter(&mut self, x: f64, y: f64, radius: f64, impulse: f64) {
        self.inner.scatter(x, y, radius, impulse);
    }

    /// Flat `[x0, y0, x1, y1, …]`.
    pub fn positions(&self) -> Vec<f64> {
        let mut flat = Vec::with_capacity(self.inner.boids.len() * 2);
        for boid in &self.inner.boids {
            flat.push(boid.x);
            flat.push(boid.y);
        }
        flat
    }

    pub fn count(&self) -> usize {
        self.inner.boids.len()
    }
}
