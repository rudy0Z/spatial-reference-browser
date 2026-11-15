//! Hybrid force relaxer — SPATIAL_BROWSER_MASTER_SPEC.md Phase 2 item 1c.
//!
//! Port of the d3-force v3 simulation driving `app/src/hooks/
//! useHybridForceLayout.ts` (d3-force 3.0.1, see app/package.json:19), with
//! the hook's hybrid contract:
//! - `fx`/`fy` locked anchors never drift (d3 integration locks them every
//!   tick — simulation.js:51-57),
//! - only freshly spawned satellites (`is_new`) are energized: link/charge/
//!   collide/home forces relax them near their parent until their velocity
//!   decays (`useHybridForceLayout.ts:238-257` settle detection: velocity²
//!   < 0.02 for 30 consecutive ticks → settle event, `is_new` cleared),
//! - settled nodes are held near their persisted home by strong home forces
//!   (strength 0.55 vs satellite 0.05 — useHybridForceLayout.ts:234-235).
//!
//! Faithfully ported from d3-force v3.0.0 sources (fetched and read in
//! `scripts/d3ref/gh/`):
//! - force application order = force-map insertion order in the hook:
//!   link → charge(manyBody) → collide → homeX → homeY,
//! - link force (link.js): distance/strength formulas per link, bias by
//!   endpoint link counts, sequential iteration, `|| jiggle` for
//!   coincident endpoints,
//! - many-body (manyBody.js): Barnes–Hut quadtree approximation, theta² =
//!   0.81 (theta 0.9 default), distanceMin² = 1, distanceMax² = ∞,
//!   per-node strengths, coincident-chain leaves,
//! - collide (collide.js): quadtree per iteration (2 iterations, strength
//!   0.7), radius padding +8, pair pushed once per iteration with mass
//!   weighting `rj² / (ri² + rj²)`, only `data.index > node.index` pairs,
//! - home forces (x.js/y.js): `v += (target - pos) * strength * alpha`,
//!   NaN target → strength 0,
//! - integration (simulation.js): internal velocity multiplier
//!   `1 - velocityDecay` = 0.6 (the hook sets velocityDecay 0.4),
//!   `alpha += (alphaTarget - alpha) * alphaDecay` before forces,
//! - PRNG (lcg.js): deterministic LCG `s = (1664525·s + 1013904223) mod 2³²`
//!   seeded `s = 1` — d3 v3's own default (`lcg()` in simulation.js:26) is
//!   itself deterministic, so trajectories here are bit-reproducible.
//!
//! Parameters wired from the hook (useHybridForceLayout.ts:226-237):
//! link distance `150 + 140/max(1,weight)`, link strength
//! `min(0.12, 0.02 + weight·0.012)`, charge `-140` (new) / `-35` (settled),
//! collide radius `node.radius + 8` @ strength 0.7 × 2 iterations, home
//! strength 0.05 (new) / 0.55 (settled), alphaDecay 0.028, alphaMin 0.001,
//! initial alpha 0.5 (the hook reheats to 0.5 when new nodes join).

use crate::quadtree::QuadTree;

// ---------------------------------------------------------------- inputs

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ForceNodeInput {
    pub uuid: String,
    /// Persisted home position (and the fallback when physics has not
    /// placed the node yet).
    pub x: f64,
    pub y: f64,
    /// Anchor lock (None when unpinned) — d3 `fx`/`fy`.
    pub fx: Option<f64>,
    pub fy: Option<f64>,
    /// True only for freshly spawned satellites physics may still place.
    #[serde(rename = "isNew")]
    pub is_new: bool,
    /// Collision radius (varies with semantic-zoom LOD).
    pub radius: f64,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct ForceLinkInput {
    /// Node INDEX into the input slice (the TS/wasm wrapper maps uuids).
    pub source: usize,
    pub target: usize,
    pub weight: f64,
}

// ---------------------------------------------------------------- params

/// Solver constants from `useHybridForceLayout.ts` + d3 defaults.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct ForceParams {
    /// d3 alpha start (hook reheats to this when nodes join). Default 0.5.
    pub alpha: f64,
    /// d3 alphaMin. Default 0.001.
    pub alpha_min: f64,
    /// Hook sets `.alphaDecay(0.028)`.
    pub alpha_decay: f64,
    /// d3 alphaTarget. Default 0.
    pub alpha_target: f64,
    /// Hook sets `.velocityDecay(0.4)`; d3 integrates with `1 - decay`.
    pub velocity_decay: f64,
    /// Barnes-Hut theta. Default 0.9 (theta² = 0.81).
    pub theta2: f64,
    /// many-body distanceMin². d3 default 1 (distanceMin = 1).
    pub distance_min2: f64,
    /// many-body distanceMax². d3 default ∞.
    pub distance_max2: f64,
    /// collide strength (hook: 0.7).
    pub collide_strength: f64,
    /// collide iterations (hook: 2).
    pub collide_iterations: u32,
    /// collide radius padding (hook: radius + 8).
    pub collide_padding: f64,
    /// link force iterations. d3 default 1.
    pub link_iterations: u32,
    /// charge strength for freshly spawned satellites (hook: -140).
    pub charge_new: f64,
    /// charge strength for settled nodes (hook: -35).
    pub charge_settled: f64,
    /// home strength for satellites (hook: 0.05).
    pub home_new: f64,
    /// home strength for settled nodes (hook: 0.55).
    pub home_settled: f64,
}

impl Default for ForceParams {
    fn default() -> Self {
        ForceParams {
            alpha: 0.5,
            alpha_min: 0.001,
            alpha_decay: 0.028,
            alpha_target: 0.0,
            velocity_decay: 0.4,
            theta2: 0.81,
            distance_min2: 1.0,
            distance_max2: f64::INFINITY,
            collide_strength: 0.7,
            collide_iterations: 2,
            collide_padding: 8.0,
            link_iterations: 1,
            charge_new: -140.0,
            charge_settled: -35.0,
            home_new: 0.05,
            home_settled: 0.55,
        }
    }
}

/// Settle detection thresholds (useHybridForceLayout.ts:89-92).
pub const SETTLE_VELOCITY_SQ: f64 = 0.02;
pub const SETTLE_TICKS: u32 = 30;

// ---------------------------------------------------------------- output

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SettleEvent {
    /// Node index into the input slice.
    pub node: usize,
    pub uuid: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TickReport {
    /// Satellites that crossed the settle threshold this tick
    /// (d3/hook `onSettle` — the store should commit these positions).
    pub settled: Vec<SettleEvent>,
    /// False when the solver has stopped: no unsettled satellites remain
    /// (hook stops the sim, useHybridForceLayout.ts:253-256) OR alpha
    /// decayed below alphaMin (d3 stepper stop, simulation.js:33-36).
    #[serde(rename = "stillRunning")]
    pub still_running: bool,
    /// Solver alpha after this tick.
    pub alpha: f64,
}

// ---------------------------------------------------------------- solver

#[derive(Debug, Clone)]
pub(crate) struct SimNode {
    pub uuid: String,
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    pub fx: Option<f64>,
    pub fy: Option<f64>,
    pub is_new: bool,
    pub radius: f64,
    pub home_x: f64,
    pub home_y: f64,
    pub calm_ticks: u32,
}

/// Internal link table entry — indices into the solver's node vec.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct SimLink {
    pub source: usize,
    pub target: usize,
    pub weight: f64,
}

/// Deterministic d3 LCG (lcg.js), state `s`, initial `s = 1`.
pub(crate) struct Lcg(u32);

impl Lcg {
    pub fn new() -> Self {
        Lcg(1)
    }

    pub fn next_f64(&mut self) -> f64 {
        // s = (1664525 * s + 1013904223) % 2^32 — u32 wrapping is exactly
        // the mod arithmetic; JS's `a*s + c` stays < 2^53 so no precision loss.
        let s = 1664525u32.wrapping_mul(self.0).wrapping_add(1013904223);
        self.0 = s;
        f64::from(s) / 4294967296.0
    }
}

impl Default for Lcg {
    fn default() -> Self {
        Self::new()
    }
}

/// d3 jiggle (jiggle.js): random nudge for exactly-coincident coordinates.
#[inline]
pub(crate) fn jiggle(random: &mut Lcg) -> f64 {
    (random.next_f64() - 0.5) * 1e-6
}

/// Deterministic hybrid force solver.
pub struct HybridForceSolver {
    pub(crate) nodes: Vec<SimNode>,
    pub(crate) links: Vec<SimLink>,
    link_bias: Vec<f64>,
    link_strengths: Vec<f64>,
    link_distances: Vec<f64>,
    /// Per-node many-body strengths and home strengths — recomputed when
    /// `is_new` flips (d3 recomputes on force.initialize; the hook gets the
    /// same effect by re-syncing sim nodes).
    charge_strengths: Vec<f64>,
    home_strengths_x: Vec<f64>,
    home_strengths_y: Vec<f64>,
    collide_radii: Vec<f64>,
    pub params: ForceParams,
    alpha: f64,
    random: Lcg,
    /// Scratch point array reused per quadtree build (allocation-free ticks).
    scratch: Vec<(f64, f64)>,
    /// Reusable visit stack (allocation-free Barnes-Hut / collide traversals).
    visit_stack: Vec<(usize, f64, f64, f64, f64)>,
    /// Reusable collide pair buffer (dx, dy adjustments for the visited peer).
    pair_scratch: Vec<(usize, f64, f64)>,
}

impl HybridForceSolver {
    /// Build the solver (d3 `initializeNodes` semantics): pinned nodes snap
    /// to their anchor; NaN positions get the golden-angle spiral placement
    /// (simulation.js:63-77); NaN velocities zero. Links referencing
    /// missing/identical nodes are dropped (the hook filters the same way —
    /// useHybridForceLayout.ts:221-222 — and d3 throws on unknown ids,
    /// which the no-panic law turns into a drop).
    pub fn new(nodes: Vec<ForceNodeInput>, links: &[ForceLinkInput]) -> Self {
        Self::with_params(nodes, links, ForceParams::default())
    }

    pub fn with_params(nodes: Vec<ForceNodeInput>, links: &[ForceLinkInput], params: ForceParams) -> Self {
        let mut sim_nodes: Vec<SimNode> = Vec::with_capacity(nodes.len());
        for (i, input) in nodes.into_iter().enumerate() {
            let mut x = input.x;
            let mut y = input.y;
            let mut vx = 0.0f64;
            let mut vy = 0.0f64;
            // d3: pinned positions snap BEFORE the NaN spiral check.
            if let Some(fx) = input.fx {
                x = fx;
            }
            if let Some(fy) = input.fy {
                y = fy;
            }
            if x.is_nan() || y.is_nan() {
                // simulation.js:69-71 spiral
                let radius = 10.0 * (0.5 + i as f64).sqrt();
                let angle = i as f64 * std::f64::consts::PI * (3.0 - 5.0f64.sqrt());
                x = radius * angle.cos();
                y = radius * angle.sin();
            }
            if vx.is_nan() || vy.is_nan() {
                vx = 0.0;
                vy = 0.0;
            }
            sim_nodes.push(SimNode {
                uuid: input.uuid,
                x,
                y,
                vx,
                vy,
                fx: input.fx,
                fy: input.fy,
                is_new: input.is_new,
                radius: input.radius,
                home_x: input.x,
                home_y: input.y,
                calm_ticks: 0,
            });
        }

        let mut solver = HybridForceSolver {
            nodes: sim_nodes,
            links: Vec::new(),
            link_bias: Vec::new(),
            link_strengths: Vec::new(),
            link_distances: Vec::new(),
            charge_strengths: Vec::new(),
            home_strengths_x: Vec::new(),
            home_strengths_y: Vec::new(),
            collide_radii: Vec::new(),
            params,
            alpha: 0.0,
            random: Lcg::new(),
            scratch: Vec::new(),
            visit_stack: Vec::new(),
            pair_scratch: Vec::new(),
        };
        solver.alpha = solver.params.alpha;
        // valid link = both endpoints distinct and in range
        let valid: Vec<SimLink> = links
            .iter()
            .filter(|l| l.source != l.target && l.source < solver.nodes.len() && l.target < solver.nodes.len())
            .map(|l| SimLink { source: l.source, target: l.target, weight: l.weight })
            .collect();
        solver.set_links(valid);
        solver.recompute_strengths();
        solver
    }

    /// (Re)build link force tables — port of link.js `initialize`.
    pub fn set_links(&mut self, links: Vec<SimLink>) {
        let n = self.nodes.len();
        let mut count = vec![0usize; n];
        self.links = links;
        for link in &self.links {
            count[link.source] += 1;
            count[link.target] += 1;
        }
        self.link_bias.clear();
        self.link_strengths.clear();
        self.link_distances.clear();
        for link in &self.links {
            let (cs, ct) = (count[link.source] as f64, count[link.target] as f64);
            // link.js:67 — bias[i] = count[source] / (count[source] + count[target])
            self.link_bias.push(cs / (cs + ct));
            // Hook formula (useHybridForceLayout.ts:228-229):
            // distance 150 + 140/max(1,weight); strength min(0.12, 0.02 + weight*0.012)
            let weight = link.weight;
            self.link_distances.push(150.0 + 140.0 / 1.0f64.max(weight));
            self.link_strengths.push(0.12f64.min(0.02 + weight * 0.012));
        }
    }

    /// Recompute per-node force tables (d3 force.initialize on nodes change):
    /// charge strengths (hook forceManyBody), home strengths (hook forceX/Y
    /// with NaN-target → 0 guard from x.js:23), collide radii (hook radius+8).
    pub fn recompute_strengths(&mut self) {
        self.charge_strengths.clear();
        self.home_strengths_x.clear();
        self.home_strengths_y.clear();
        self.collide_radii.clear();
        for node in &self.nodes {
            self.charge_strengths.push(if node.is_new { self.params.charge_new } else { self.params.charge_settled });
            let (hx, hy) = (node.home_x, node.home_y);
            // x.js:23 — isNaN(target) → strength 0
            self.home_strengths_x.push(if hx.is_nan() { 0.0 } else { if node.is_new { self.params.home_new } else { self.params.home_settled } });
            self.home_strengths_y.push(if hy.is_nan() { 0.0 } else { if node.is_new { self.params.home_new } else { self.params.home_settled } });
            self.collide_radii.push(node.radius + self.params.collide_padding);
        }
    }

    /// Insert a node (index = new length). New nodes are initialized like
    /// `initialize_nodes` (spiral when NaN) and force tables are refreshed.
    pub fn push_node(&mut self, input: ForceNodeInput) -> usize {
        let i = self.nodes.len();
        let mut x = input.x;
        let mut y = input.y;
        let mut vx = 0.0f64;
        let mut vy = 0.0f64;
        if let Some(fx) = input.fx {
            x = fx;
        }
        if let Some(fy) = input.fy {
            y = fy;
        }
        if x.is_nan() || y.is_nan() {
            let radius = 10.0 * (0.5 + i as f64).sqrt();
            let angle = i as f64 * std::f64::consts::PI * (3.0 - 5.0f64.sqrt());
            x = radius * angle.cos();
            y = radius * angle.sin();
        }
        if vx.is_nan() || vy.is_nan() {
            vx = 0.0;
            vy = 0.0;
        }
        self.nodes.push(SimNode {
            uuid: input.uuid,
            x,
            y,
            vx,
            vy,
            fx: input.fx,
            fy: input.fy,
            is_new: input.is_new,
            radius: input.radius,
            home_x: input.x,
            home_y: input.y,
            calm_ticks: 0,
        });
        self.recompute_strengths();
        i
    }

    /// Update a node's persisted home + anchor + radius (the hook's sync
    /// path, useHybridForceLayout.ts:191-208) without touching velocities.
    pub fn update_node(&mut self, index: usize, x: f64, y: f64, fx: Option<f64>, fy: Option<f64>, is_new: bool, radius: f64) {
        let Some(node) = self.nodes.get_mut(index) else { return };
        node.home_x = x;
        node.home_y = y;
        node.fx = fx;
        node.fy = fy;
        // Hook: fresh `isNew` flag re-seeds position + velocity (200-205).
        if is_new && !node.is_new {
            node.x = x;
            node.y = y;
            node.vx = 0.0;
            node.vy = 0.0;
        }
        node.is_new = is_new;
        node.radius = radius;
        self.recompute_strengths();
    }

    /// Re-energize the simulation (hook `reheat`, useHybridForceLayout.ts:280-285).
    pub fn reheat(&mut self, intensity: f64) {
        self.alpha = intensity;
    }

    pub fn alpha(&self) -> f64 {
        self.alpha
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn node_position(&self, index: usize) -> Option<(f64, f64)> {
        self.nodes.get(index).map(|n| (n.x, n.y))
    }

    /// Current positions as parallel arrays `xs`/`ys` (wasm-friendly).
    pub fn positions(&self) -> (Vec<f64>, Vec<f64>) {
        (
            self.nodes.iter().map(|n| n.x).collect(),
            self.nodes.iter().map(|n| n.y).collect(),
        )
    }

    /// Current velocities (diagnostics/tests).
    pub fn velocities(&self) -> (Vec<f64>, Vec<f64>) {
        (
            self.nodes.iter().map(|n| n.vx).collect(),
            self.nodes.iter().map(|n| n.vy).collect(),
        )
    }

    /// One d3 tick: alpha update → forces (link, charge, collide, homeX,
    /// homeY) → integration → settle detection. Pure; deterministic.
    pub fn tick(&mut self) -> TickReport {
        let n = self.nodes.len();
        let mut report = TickReport { settled: Vec::new(), still_running: false, alpha: self.alpha };

        if n == 0 {
            return TickReport { settled: Vec::new(), still_running: false, alpha: self.alpha };
        }

        // simulation.js:45 — alpha approaches the target before forces.
        self.alpha += (self.params.alpha_target - self.alpha) * self.params.alpha_decay;
        report.alpha = self.alpha;

        let alpha = self.alpha;
        let params = self.params;
        self.scratch.clear();
        self.scratch.reserve(n);

        // ---- 1. link force (link.js force(alpha), iterations = 1)
        for _k in 0..params.link_iterations {
            for (li, link) in self.links.iter().enumerate() {
                // Split borrows: source ≠ target (validated at build).
                let (s, t): (&mut SimNode, &mut SimNode) = if link.source < link.target {
                    let (left, right) = self.nodes.split_at_mut(link.target);
                    (&mut left[link.source], &mut right[0])
                } else {
                    let (left, right) = self.nodes.split_at_mut(link.source);
                    (&mut right[0], &mut left[link.target])
                };
                let mut x = (t.x + t.vx) - (s.x + s.vx);
                let mut y = (t.y + t.vy) - (s.y + s.vy);
                // link.js:36-37 `|| jiggle(random)` — zero OR NaN triggers.
                if x == 0.0 || x.is_nan() {
                    x = jiggle(&mut self.random);
                }
                if y == 0.0 || y.is_nan() {
                    y = jiggle(&mut self.random);
                }
                let mut l = (x * x + y * y).sqrt();
                // link.js:39
                l = (l - self.link_distances[li]) / l * alpha * self.link_strengths[li];
                x *= l;
                y *= l;
                let b = self.link_bias[li];
                t.vx -= x * b;
                t.vy -= y * b;
                s.vx += x * (1.0 - b);
                s.vy += y * (1.0 - b);
            }
        }

        // ---- 2. charge / many-body (manyBody.js force(alpha))
        {
            self.scratch.clear();
            for node in &self.nodes {
                self.scratch.push((node.x, node.y));
            }
            let mut tree = QuadTree::from_points(&self.scratch);
            tree.accumulate_charge(&self.charge_strengths);
            let theta2 = params.theta2;
            let distance_min2 = params.distance_min2;
            let distance_max2 = params.distance_max2;
            for i in 0..n {
                // manyBody.js:19 — tree.visit(apply) per node
                let node_x = self.nodes[i].x;
                let node_y = self.nodes[i].y;
                let mut vx_add = 0.0;
                let mut vy_add = 0.0;
                let mut random = &mut self.random;
                let strengths = &self.charge_strengths;
                // reuse the visit stack across all 1000 visits (allocation-free)
                let stack = &mut self.visit_stack;
                tree.visit_with_stack(stack, |quad, x1, _y1, x2, _y2| {
                    // manyBody.js:56 — `if (!quad.value) return true` prunes
                    // zero AND NaN charge subtrees.
                    if quad.charge == 0.0 || quad.charge.is_nan() {
                        return true;
                    }
                    let mut x = quad.charge_x - node_x;
                    let mut y = quad.charge_y - node_y;
                    let w = x2 - x1;
                    let mut l = x * x + y * y;
                    if w * w / theta2 < l {
                        // Barnes-Hut approximation (manyBody.js:65-74)
                        if l < distance_max2 {
                            if x == 0.0 {
                                x = jiggle(&mut random);
                                l += x * x;
                            }
                            if y == 0.0 {
                                y = jiggle(&mut random);
                                l += y * y;
                            }
                            if l < distance_min2 {
                                l = (distance_min2 * l).sqrt();
                            }
                            vx_add += x * quad.charge * alpha / l;
                            vy_add += y * quad.charge * alpha / l;
                        }
                        return true;
                    }
                    // Not far enough → process points directly.
                    if quad.is_internal || l >= distance_max2 {
                        return false;
                    }
                    // Leaf: clamp when the chain is not exactly self
                    // (manyBody.js:80-84)
                    if quad.indices.len() != 1 || quad.indices[0] != i {
                        if x == 0.0 {
                            x = jiggle(&mut random);
                            l += x * x;
                        }
                        if y == 0.0 {
                            y = jiggle(&mut random);
                            l += y * y;
                        }
                        if l < distance_min2 {
                            l = (distance_min2 * l).sqrt();
                        }
                    }
                    // manyBody.js:86-90 — chain iteration head → tail
                    for &idx in &quad.indices {
                        if idx != i {
                            let w = strengths[idx] * alpha / l;
                            vx_add += x * w;
                            vy_add += y * w;
                        }
                    }
                    false
                });
                self.nodes[i].vx += vx_add;
                self.nodes[i].vy += vy_add;
            }
        }

        // ---- 3. collide (collide.js force(), iterations = 2)
        {
            let strength = params.collide_strength;
            let iterations = params.collide_iterations;
            let radii = &self.collide_radii;
            for _k in 0..iterations {
                // Tree on predicted positions x+vx (collide.js:5-11, 32)
                self.scratch.clear();
                for node in &self.nodes {
                    self.scratch.push((node.x + node.vx, node.y + node.vy));
                }
                let mut tree = QuadTree::from_points(&self.scratch);
                tree.prepare_radius(radii);
                for i in 0..n {
                    let ri = radii[i];
                    let ri2 = ri * ri;
                    let xi = self.nodes[i].x + self.nodes[i].vx;
                    let yi = self.nodes[i].y + self.nodes[i].vy;
                    let mut vx_add = 0.0;
                    let mut vy_add = 0.0;
                    // (index, dx, dy) adjustments applied to the OTHER node
                    // right after the visit pass (d3 applies them inline).
                    let mut random = &mut self.random;
                    let others = &mut self.pair_scratch;
                    others.clear();
                    let stack = &mut self.visit_stack;
                    tree.visit_with_stack(stack, |quad, x0, y0, x1, y1| {
                        if quad.is_internal {
                            // collide.js:61 — prune when extent misses the circle
                            let r = ri + quad.radius;
                            let prune = x0 > xi + r || x1 < xi - r || y0 > yi + r || y1 < yi - r;
                            return prune;
                        }
                        // Leaf — collide compares the chain HEAD only
                        // (collide.js:44-58 reads quad.data / quad.r).
                        let data_index = quad.indices[0];
                        let rj = quad.radius;
                        let r = ri + rj;
                        if data_index > i {
                            let data = &self.nodes[data_index];
                            let mut x = xi - data.x - data.vx;
                            let mut y = yi - data.y - data.vy;
                            let mut l = x * x + y * y;
                            if l < r * r {
                                if x == 0.0 {
                                    x = jiggle(&mut random);
                                    l += x * x;
                                }
                                if y == 0.0 {
                                    y = jiggle(&mut random);
                                    l += y * y;
                                }
                                l = (r - l.sqrt()) / l * strength;
                                x *= l;
                                y *= l;
                                let mass = (rj * rj) / (ri2 + rj * rj);
                                vx_add += x * mass;
                                vy_add += y * mass;
                                others.push((data_index, -x * (1.0 - mass), -y * (1.0 - mass)));
                            }
                        }
                        // Leaf never descends (collide.js:59)
                        true
                    });
                    self.nodes[i].vx += vx_add;
                    self.nodes[i].vy += vy_add;
                    for &(idx, dx, dy) in others.iter() {
                        self.nodes[idx].vx += dx;
                        self.nodes[idx].vy += dy;
                    }
                }
            }
        }

        // ---- 4. homeX / homeY forces (x.js force(alpha) / y.js)
        for i in 0..n {
            let (node_x, node_y, hx, hy, sx, sy) = {
                let node = &self.nodes[i];
                let hx = node.home_x;
                let hy = node.home_y;
                let sx = self.home_strengths_x[i];
                let sy = self.home_strengths_y[i];
                (node.x, node.y, hx, hy, sx, sy)
            };
            self.nodes[i].vx += (hx - node_x) * sx * alpha;
            self.nodes[i].vy += (hy - node_y) * sy * alpha;
        }

        // ---- 5. integration (simulation.js:51-57)
        let decay = 1.0 - params.velocity_decay;
        for node in &mut self.nodes {
            if let Some(fx) = node.fx {
                node.x = fx;
                node.vx = 0.0;
            } else {
                node.vx *= decay;
                node.x += node.vx;
            }
            if let Some(fy) = node.fy {
                node.y = fy;
                node.vy = 0.0;
            } else {
                node.vy *= decay;
                node.y += node.vy;
            }
        }

        // ---- 6. settle detection (useHybridForceLayout.ts:238-257)
        let mut still_new = false;
        for i in 0..n {
            if !self.nodes[i].is_new {
                continue;
            }
            let velocity_sq = self.nodes[i].vx * self.nodes[i].vx + self.nodes[i].vy * self.nodes[i].vy;
            if velocity_sq < SETTLE_VELOCITY_SQ {
                self.nodes[i].calm_ticks += 1;
            } else {
                self.nodes[i].calm_ticks = 0;
            }
            if self.nodes[i].calm_ticks >= SETTLE_TICKS {
                self.nodes[i].is_new = false;
                let node = &self.nodes[i];
                report.settled.push(SettleEvent { node: i, uuid: node.uuid.clone(), x: node.x, y: node.y });
            } else {
                still_new = true;
            }
        }

        // d3 auto-stops below alphaMin; the hook stops once no satellites
        // remain unsettled (both honored — either stop freezes relaxation).
        report.still_running = still_new && self.alpha >= self.params.alpha_min;
        report
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(uuid: &str, x: f64, y: f64, fx: Option<f64>, fy: Option<f64>, is_new: bool) -> ForceNodeInput {
        ForceNodeInput { uuid: uuid.to_string(), x, y, fx, fy, is_new, radius: 16.0 }
    }

    #[test]
    fn lcg_matches_d3_sequence() {
        // d3 lcg.js with s=1 — sequence verified against the reference
        // implementation via node: 0.23645552527159452, 0.3692706737201661
        let mut rng = Lcg::new();
        let first = rng.next_f64();
        assert_eq!(first, 1015568748.0 / 4294967296.0);
        assert_eq!(format!("{first}"), "0.23645552527159452");
        let second = rng.next_f64();
        let expected_s2 = ((1664525u64 * 1015568748 + 1013904223) % 4294967296) as u32;
        assert_eq!(second, f64::from(expected_s2) / 4294967296.0);
        assert_eq!(format!("{second}"), "0.3692706737201661");
    }

    #[test]
    fn jiggle_is_tiny_and_bounded() {
        let mut rng = Lcg::new();
        for _ in 0..100 {
            let j = jiggle(&mut rng);
            assert!(j.abs() <= 5e-7, "jiggle {j}");
        }
    }

    #[test]
    fn pinned_nodes_never_drift() {
        let nodes = vec![
            node("pin", 100.0, 200.0, Some(100.0), Some(200.0), false),
            node("sat", 130.0, 210.0, None, None, true),
        ];
        let links = vec![ForceLinkInput { source: 0, target: 1, weight: 1.0 }];
        let mut solver = HybridForceSolver::new(nodes, &links);
        for _ in 0..60 {
            solver.tick();
        }
        let (xs, ys) = solver.positions();
        assert_eq!(xs[0], 100.0);
        assert_eq!(ys[0], 200.0);
        assert_eq!(xs[0], 100.0);
        // velocity of pinned node is always zeroed
        let (vx, vy) = solver.velocities();
        assert_eq!(vx[0], 0.0);
        assert_eq!(vy[0], 0.0);
    }

    #[test]
    fn pinned_snap_on_init_even_with_nan_other_coord() {
        // d3 simulation.js:66-75 — pin assignment happens before the NaN
        // spiral; a NaN other coordinate triggers the spiral for BOTH.
        let nodes = vec![node("a", 42.0, f64::NAN, Some(42.0), None, false)];
        let solver = HybridForceSolver::new(nodes, &[]);
        let (xs, ys) = solver.positions();
        // spiral init overwrote BOTH coords (matches d3 quirk)
        assert!(xs[0].is_finite() && ys[0].is_finite());
        assert_ne!(xs[0], 42.0);
    }

    #[test]
    fn nan_position_gets_spiral_init() {
        let nodes = vec![node("a", f64::NAN, f64::NAN, None, None, false)];
        let solver = HybridForceSolver::new(nodes, &[]);
        let (xs, ys) = solver.positions();
        // i=0: radius 10*sqrt(0.5), angle 0 → (7.071..., 0)
        assert!((xs[0] - 10.0 * 0.5f64.sqrt()).abs() < 1e-12);
        assert!(ys[0].abs() < 1e-12);
    }

    #[test]
    fn linked_satellites_relax_toward_link_distance() {
        // Two satellites 400px apart, link distance 290 (weight 1: 150+140)
        // → they should pull toward ~290.
        let nodes = vec![
            node("a", 0.0, 0.0, None, None, true),
            node("b", 400.0, 0.0, None, None, true),
        ];
        let links = vec![ForceLinkInput { source: 0, target: 1, weight: 1.0 }];
        let mut solver = HybridForceSolver::new(nodes, &links);
        for _ in 0..400 {
            solver.tick();
        }
        let (xs, ys) = solver.positions();
        let dist = ((xs[0] - xs[1]).powi(2) + (ys[0] - ys[1]).powi(2)).sqrt();
        // link wants 290; charge pushes apart; collide +8. Accept a band.
        assert!(dist > 250.0 && dist < 400.0, "relaxed distance {dist}");
        assert!((ys[0] - ys[1]).abs() < 1.0, "stays on the axis, dy {}", (ys[0] - ys[1]));
    }

    #[test]
    fn satellites_settle_and_stop() {
        let nodes = vec![node("a", 0.0, 0.0, None, None, true), node("b", 100.0, 0.0, None, None, true)];
        let links = vec![ForceLinkInput { source: 0, target: 1, weight: 1.0 }];
        let mut solver = HybridForceSolver::new(nodes, &links);
        let mut settled_count = 0;
        let mut running = true;
        for _ in 0..5000 {
            let report = solver.tick();
            settled_count += report.settled.len();
            running = report.still_running;
            if !running {
                break;
            }
        }
        assert_eq!(settled_count, 2, "both satellites settle");
        assert!(!running, "solver stops after settling");
        // settle positions are finite
        let (xs, ys) = solver.positions();
        assert!(xs[0].is_finite() && ys[0].is_finite() && xs[1].is_finite() && ys[1].is_finite());
    }

    #[test]
    fn settle_event_positions_are_committed_finite() {
        let nodes = vec![node("sat", 50.0, 50.0, None, None, true), node("anchor", 200.0, 200.0, Some(200.0), Some(200.0), false)];
        let links = vec![ForceLinkInput { source: 0, target: 1, weight: 2.0 }];
        let mut solver = HybridForceSolver::new(nodes, &links);
        let mut events = Vec::new();
        for _ in 0..5000 {
            let report = solver.tick();
            events.extend(report.settled);
            if !report.still_running {
                break;
            }
        }
        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(event.uuid, "sat");
        assert!(event.x.is_finite() && event.y.is_finite());
        // satellite relaxed near its parent anchor (link distance 150+140/2=220)
        let dx = event.x - 200.0;
        let dy = event.y - 200.0;
        let dist = (dx * dx + dy * dy).sqrt();
        assert!(dist < 320.0, "settled near parent, dist {dist}");
    }

    #[test]
    fn settled_node_pulled_back_to_home_by_home_force() {
        // A settled node displaced from home: home strength 0.55 drags it
        // back while charge is weak (-35).
        let nodes = vec![node("a", 500.0, 500.0, None, None, false)];
        let mut solver = HybridForceSolver::new(nodes, &[]);
        solver.nodes[0].home_x = 0.0;
        solver.nodes[0].home_y = 0.0;
        solver.recompute_strengths();
        for _ in 0..120 {
            solver.tick();
        }
        let (xs, ys) = solver.positions();
        assert!(xs[0] < 50.0 && ys[0] < 50.0, "dragged home: ({}, {})", xs[0], ys[0]);
    }

    #[test]
    fn collide_pushes_overlapping_nodes_apart() {
        // Two settled nodes fully overlapping: collide (radius+8) must
        // separate them. Home forces pull back while alpha is live, so the
        // clean ~2·(radius+8)=48 equilibrium appears once alpha decays.
        let nodes = vec![
            node("a", 0.0, 0.0, None, None, false),
            node("b", 1.0, 1.0, None, None, false),
        ];
        let mut solver = HybridForceSolver::new(nodes, &[]);
        for _ in 0..300 {
            solver.tick();
        }
        let (xs, ys) = solver.positions();
        let dist = ((xs[0] - xs[1]).powi(2) + (ys[0] - ys[1]).powi(2)).sqrt();
        assert!(dist > 40.0, "separated near 2*(radius+8): {dist}");
    }

    #[test]
    fn frozen_solver_is_caller_side_noop() {
        // The hook's `frozen` stops ticks entirely; verify ticks are pure —
        // not calling tick leaves state untouched.
        let nodes = vec![node("a", 10.0, 20.0, None, None, true)];
        let solver = HybridForceSolver::new(nodes, &[]);
        let (x0, y0) = solver.node_position(0).unwrap();
        // (no tick)
        let (x1, y1) = solver.node_position(0).unwrap();
        assert_eq!((x0, y0), (x1, y1));
    }

    #[test]
    fn deterministic_identical_trajectories() {
        let build = || {
            let nodes: Vec<ForceNodeInput> = (0..12)
                .map(|i| node(&format!("n{i}"), (i * 37) as f64 % 300.0, (i * 53) as f64 % 200.0, None, None, i % 3 == 0))
                .collect();
            let links: Vec<ForceLinkInput> = (0..11).map(|i| ForceLinkInput { source: i, target: i + 1, weight: (i % 3 + 1) as f64 }).collect();
            let mut solver = HybridForceSolver::new(nodes, &links);
            let mut trace = Vec::new();
            for _ in 0..40 {
                let report = solver.tick();
                for e in &report.settled {
                    trace.push((e.uuid.clone(), e.x.to_bits(), e.y.to_bits()));
                }
                let (xs, ys) = solver.positions();
                // fold with wrapping xor — plain sum can overflow u64
                trace.push((
                    "__tick__".into(),
                    xs.iter().fold(0u64, |acc, v| acc ^ v.to_bits()),
                    ys.iter().fold(0u64, |acc, v| acc ^ v.to_bits()),
                ));
            }
            trace
        };
        assert_eq!(build(), build(), "two runs must be bit-identical");
    }

    #[test]
    fn invalid_links_dropped_not_panicked() {
        let nodes = vec![node("a", 0.0, 0.0, None, None, false)];
        let links = vec![
            ForceLinkInput { source: 0, target: 0, weight: 1.0 }, // self
            ForceLinkInput { source: 0, target: 7, weight: 1.0 }, // out of range
            ForceLinkInput { source: 9, target: 0, weight: 1.0 }, // out of range
        ];
        let solver = HybridForceSolver::new(nodes, &links);
        assert_eq!(solver.links.len(), 0);
    }

    #[test]
    fn push_and_update_node() {
        let mut solver = HybridForceSolver::new(vec![node("a", 0.0, 0.0, None, None, false)], &[]);
        let idx = solver.push_node(node("b", 300.0, 300.0, None, None, true));
        assert_eq!(idx, 1);
        assert_eq!(solver.node_count(), 2);
        solver.update_node(1, 120.0, 120.0, None, None, false, 20.0);
        // home updated; is_new cleared
        let (xs, ys) = solver.positions();
        assert!((xs[1] - 120.0).abs() < 300.0 || (ys[1] - 120.0).abs() < 300.0);
        // out-of-range update is a no-op, not a panic
        solver.update_node(99, 0.0, 0.0, None, None, false, 1.0);
    }

    #[test]
    fn alpha_decays_and_reports_running() {
        let nodes = vec![node("a", 0.0, 0.0, None, None, true)];
        let mut solver = HybridForceSolver::new(nodes, &[]);
        let mut saw_running = false;
        let mut final_alpha = 1.0;
        for _ in 0..500 {
            let report = solver.tick();
            saw_running |= report.still_running;
            final_alpha = report.alpha;
        }
        assert!(final_alpha < 0.001, "alpha decays below alphaMin: {final_alpha}");
        assert!(saw_running, "solver reported running while relaxing");
    }

    #[test]
    fn reheat_raises_alpha() {
        let nodes = vec![node("a", 0.0, 0.0, None, None, false)];
        let mut solver = HybridForceSolver::new(nodes, &[]);
        for _ in 0..100 {
            solver.tick();
        }
        assert!(solver.alpha() < 0.1);
        solver.reheat(0.5);
        assert_eq!(solver.alpha(), 0.5);
    }

    #[test]
    fn many_nodes_no_nan_after_long_run() {
        let nodes: Vec<ForceNodeInput> = (0..200)
            .map(|i| node(&format!("n{i}"), ((i * 97) % 500) as f64, ((i * 131) % 400) as f64, None, None, i % 4 == 0))
            .collect();
        let links: Vec<ForceLinkInput> = (0..199).map(|i| ForceLinkInput { source: i, target: i + 1, weight: 1.0 }).collect();
        let mut solver = HybridForceSolver::new(nodes, &links);
        for _ in 0..200 {
            solver.tick();
        }
        let (xs, ys) = solver.positions();
        for (x, y) in xs.iter().zip(ys.iter()) {
            assert!(x.is_finite() && y.is_finite(), "no NaN drift");
        }
    }
}

#[cfg(test)]
mod profile_tests {
    use crate::quadtree::QuadTree;
    use std::time::Instant;

    #[test]
    fn profile_quadtree_stages() {
        let n = 1000;
        let mut s = 20261115u32;
        let mut rng = || {
            s = 1664525u32.wrapping_mul(s).wrapping_add(1013904223);
            f64::from(s) / 4294967296.0
        };
        let points: Vec<(f64, f64)> = (0..n).map(|_| (rng() * 6000.0 - 1000.0, rng() * 4500.0 - 800.0)).collect();
        let strengths: Vec<f64> = (0..n).map(|i| if i % 10 == 0 { -140.0 } else { -35.0 }).collect();

        let t0 = Instant::now();
        let mut tree = QuadTree::from_points(&points);
        let build = t0.elapsed();

        let t0 = Instant::now();
        tree.accumulate_charge(&strengths);
        let accumulate = t0.elapsed();

        let t0 = Instant::now();
        let mut visits = 0usize;
        for i in 0..n {
            let (node_x, node_y) = (points[i].0, points[i].1);
            tree.visit(|_quad, _x0, _y0, _x1, _y1| {
                visits += 1;
                false
            });
            let _ = (node_x, node_y);
        }
        let visit_all = t0.elapsed();
        println!("quadtree @ {n}: build {build:?}, accumulate {accumulate:?}, 1000 full visits {visit_all:?} (avg per visit {}ns)", visit_all.as_nanos() / 1000);
        assert!(true);
    }
}
