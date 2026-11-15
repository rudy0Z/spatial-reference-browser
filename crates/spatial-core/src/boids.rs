//! Boids flocking engine — SPATIAL_BROWSER_MASTER_SPEC.md Phase 2 item 1e
//! and HANDOFF.md §5.10 (founder-directed delight layer): 100–500 agents,
//! spatial-hash grid neighborhoods, separation/alignment/cohesion, cursor
//! scatter, < 0.5 ms per step, fully deterministic, no NaN ever leaves a
//! step (non-finite state is sanitized back to the safe default).
//!
//! The classic rules (Reynolds) with the spicyyoghurt.com boids-tutorial
//! formulation referenced in the research: per-agent forces are computed
//! from neighbors within `neighbor_radius`, each steering force is limited
//! to `max_force` before weighting, speed is clamped to `[min_speed,
//! max_speed]`, and agents steer softly back inside the world rect.
//!
//! Determinism: the only randomness is the SEEDED initial placement; every
//! step is a pure function of the previous state. Neighbor candidates are
//! collected in ascending-index order so float sums are reproducible.

/// Tunable simulation constants (documented defaults; all `pub` so the
/// Phase 3 new-tab experience can pin them in Tweaks).
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct BoidParams {
    /// Neighborhood radius (px) — alignment/cohesion sample set.
    #[serde(rename = "neighborRadius")]
    pub neighbor_radius: f64,
    /// Separation radius (px) — personal space.
    #[serde(rename = "separationRadius")]
    pub separation_radius: f64,
    /// Rule weights (spicyyoghurt defaults).
    #[serde(rename = "separationWeight")]
    pub separation_weight: f64,
    #[serde(rename = "alignmentWeight")]
    pub alignment_weight: f64,
    #[serde(rename = "cohesionWeight")]
    pub cohesion_weight: f64,
    /// Speed clamps (px per step).
    #[serde(rename = "maxSpeed")]
    pub max_speed: f64,
    #[serde(rename = "minSpeed")]
    pub min_speed: f64,
    /// Per-force steering limit (px/step²).
    #[serde(rename = "maxForce")]
    pub max_force: f64,
    /// Cursor scatter: repulsion radius (px) and peak strength.
    #[serde(rename = "cursorScatterRadius")]
    pub cursor_scatter_radius: f64,
    #[serde(rename = "cursorScatterStrength")]
    pub cursor_scatter_strength: f64,
    /// Soft boundary margin (px) — agents inside the margin steer inward.
    #[serde(rename = "boundsMargin")]
    pub bounds_margin: f64,
}

impl Default for BoidParams {
    fn default() -> Self {
        BoidParams {
            neighbor_radius: 55.0,
            separation_radius: 24.0,
            separation_weight: 1.5,
            alignment_weight: 1.0,
            cohesion_weight: 0.8,
            max_speed: 3.2,
            min_speed: 0.35,
            max_force: 0.07,
            cursor_scatter_radius: 120.0,
            cursor_scatter_strength: 1.6,
            bounds_margin: 40.0,
        }
    }
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct Boid {
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    /// Visual species byte (Phase 3 "species selector"); simulation-neutral.
    pub species: u8,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct BoidWorld {
    #[serde(rename = "minX")]
    pub min_x: f64,
    #[serde(rename = "minY")]
    pub min_y: f64,
    #[serde(rename = "maxX")]
    pub max_x: f64,
    #[serde(rename = "maxY")]
    pub max_y: f64,
}

impl BoidWorld {
    /// Finite-rect guard: non-finite corners collapse to the 1×1 unit rect
    /// (no-panic law).
    pub fn sanitized(min_x: f64, min_y: f64, max_x: f64, max_y: f64) -> Self {
        let (min_x, min_y, max_x, max_y) = if min_x.is_finite() && min_y.is_finite() && max_x.is_finite() && max_y.is_finite() && min_x < max_x && min_y < max_y {
            (min_x, min_y, max_x, max_y)
        } else {
            (0.0, 0.0, 1.0, 1.0)
        };
        BoidWorld { min_x, min_y, max_x, max_y }
    }

    pub fn width(&self) -> f64 {
        self.max_x - self.min_x
    }

    pub fn height(&self) -> f64 {
        self.max_y - self.min_y
    }
}

/// Uniform spatial-hash grid: cell size = neighbor_radius, one cell per
/// (cx, cy) pair, 3×3 neighbor collection.
struct SpatialHash {
    cell: f64,
    cols: i64,
    rows: i64,
    /// cells[(cy * cols + cx)] → agent indices (ascending by construction).
    cells: Vec<Vec<u32>>,
}

impl SpatialHash {
    fn new(cell: f64, world: &BoidWorld, agent_count: usize) -> Self {
        let width = world.width().max(1.0);
        let height = world.height().max(1.0);
        let cols = ((width / cell).ceil() as i64).clamp(1, 4096);
        let rows = ((height / cell).ceil() as i64).clamp(1, 4096);
        SpatialHash { cell, cols, rows, cells: vec![Vec::with_capacity(agent_count / ((cols * rows).max(1) as usize).max(1) + 1); (cols * rows) as usize] }
    }

    fn cell_of(&self, x: f64, y: f64, world: &BoidWorld) -> (i64, i64) {
        // Agents may briefly sit outside the world rect (steer-back lag) —
        // clamp into the grid so queries never miss cells.
        let cx = (((x - world.min_x) / self.cell).floor() as i64).clamp(0, self.cols - 1);
        let cy = (((y - world.min_y) / self.cell).floor() as i64).clamp(0, self.rows - 1);
        (cx, cy)
    }

    fn insert(&mut self, x: f64, y: f64, world: &BoidWorld, index: u32) {
        let (cx, cy) = self.cell_of(x, y, world);
        self.cells[(cy * self.cols + cx) as usize].push(index);
    }

    /// Indices in the 3×3 cells around (x, y), ascending order.
    fn query_3x3(&self, x: f64, y: f64, world: &BoidWorld, out: &mut Vec<u32>) {
        let (cx, cy) = self.cell_of(x, y, world);
        out.clear();
        for dy in -1..=1 {
            let ny = cy + dy;
            if ny < 0 || ny >= self.rows {
                continue;
            }
            for dx in -1..=1 {
                let nx = cx + dx;
                if nx < 0 || nx >= self.cols {
                    continue;
                }
                out.extend_from_slice(&self.cells[(ny * self.cols + nx) as usize]);
            }
        }
        // Cells were pushed in ascending (dy, dx) order and each cell holds
        // ascending indices, but the 3×3 merge is not globally sorted — sort
        // for deterministic float-sum order.
        out.sort_unstable();
    }
}

/// Deterministic boids simulation.
pub struct BoidSim {
    pub boids: Vec<Boid>,
    pub world: BoidWorld,
    pub params: BoidParams,
    neighbor_scratch: Vec<u32>,
}

/// Deterministic LCG — same construction as [`crate::force`] (seed 1).
fn lcg(seed: u32) -> impl FnMut() -> f64 {
    let mut s = seed;
    move || {
        s = 1664525u32.wrapping_mul(s).wrapping_add(1013904223);
        f64::from(s) / 4294967296.0
    }
}

impl BoidSim {
    /// Create `count` agents placed uniformly at random inside the world
    /// (seeded → deterministic), velocities at random heading.
    /// `count` clamps to 1..=4096; non-finite world corners are sanitized.
    pub fn new(seed: u32, count: usize, world: BoidWorld, params: BoidParams) -> Self {
        let world = BoidWorld::sanitized(world.min_x, world.min_y, world.max_x, world.max_y);
        let count = count.clamp(1, 4096);
        let mut rng = lcg(seed.max(1));
        let mut boids = Vec::with_capacity(count);
        for _ in 0..count {
            let x = world.min_x + rng() * world.width();
            let y = world.min_y + rng() * world.height();
            let angle = rng() * std::f64::consts::TAU;
            boids.push(Boid { x, y, vx: angle.cos() * params.max_speed * 0.5, vy: angle.sin() * params.max_speed * 0.5, species: 0 });
        }
        BoidSim { boids, world, params, neighbor_scratch: Vec::new() }
    }

    /// Advance one step. `cursor` (if finite) repels nearby agents.
    /// Fully deterministic; never panics; never emits NaN.
    pub fn step(&mut self, cursor: Option<(f64, f64)>) {
        let params = self.params;
        let world = self.world;
        let mut grid = SpatialHash::new(params.neighbor_radius, &world, self.boids.len());
        for (i, boid) in self.boids.iter().enumerate() {
            grid.insert(boid.x, boid.y, &world, i as u32);
        }
        let neighbor_radius2 = params.neighbor_radius * params.neighbor_radius;
        let separation_radius2 = params.separation_radius * params.separation_radius;
        for i in 0..self.boids.len() {
            let (mut fx, mut fy) = (0.0f64, 0.0f64);
            let boid = self.boids[i];
            self.neighbor_scratch.clear();
            grid.query_3x3(boid.x, boid.y, &world, &mut self.neighbor_scratch);
            // accumulators
            let (mut sep_x, mut sep_y) = (0.0, 0.0);
            let (mut align_x, mut align_y) = (0.0, 0.0);
            let (mut cohe_x, mut cohe_y) = (0.0, 0.0);
            let mut neighbor_count = 0u32;
            for &j in &self.neighbor_scratch {
                if j as usize == i {
                    continue;
                }
                let other = self.boids[j as usize];
                let dx = boid.x - other.x;
                let dy = boid.y - other.y;
                let dist2 = dx * dx + dy * dy;
                if dist2 > neighbor_radius2 {
                    continue;
                }
                neighbor_count += 1;
                align_x += other.vx;
                align_y += other.vy;
                cohe_x += other.x;
                cohe_y += other.y;
                if dist2 < separation_radius2 && dist2 > 0.0 {
                    let dist = dist2.sqrt();
                    // linear falloff away-vector (spicyyoghurt-style)
                    let falloff = 1.0 - dist / params.separation_radius;
                    let inv = 1.0 / dist;
                    sep_x += dx * inv * falloff;
                    sep_y += dy * inv * falloff;
                } else if dist2 == 0.0 {
                    // exactly coincident: push in a stable pseudo-random-ish
                    // direction derived from the agent indices (deterministic)
                    let angle = (i as f64) * 2.399963229728653; // golden angle
                    sep_x += angle.cos();
                    sep_y += angle.sin();
                }
            }
            // separation: already a direction vector; limit to max_force
            let (sx, sy) = limit_force(sep_x, sep_y, params.max_force);
            fx += sx * params.separation_weight;
            fy += sy * params.separation_weight;
            if neighbor_count > 0 {
                let count_inv = 1.0 / neighbor_count as f64;
                // alignment: steer toward the average heading
                let (ax, ay) = limit_force(align_x * count_inv, align_y * count_inv, params.max_force);
                fx += ax * params.alignment_weight;
                fy += ay * params.alignment_weight;
                // cohesion: steer toward the average position
                let (cx, cy) = limit_force(cohe_x * count_inv - boid.x, cohe_y * count_inv - boid.y, params.max_force);
                fx += cx * params.cohesion_weight;
                fy += cy * params.cohesion_weight;
            }
            // cursor scatter: repulsion inside the scatter radius
            if let Some((cx, cy)) = cursor {
                if cx.is_finite() && cy.is_finite() {
                    let dx = boid.x - cx;
                    let dy = boid.y - cy;
                    let dist2 = dx * dx + dy * dy;
                    if dist2 < params.cursor_scatter_radius * params.cursor_scatter_radius && dist2 > 0.0 {
                        let dist = dist2.sqrt();
                        let falloff = 1.0 - dist / params.cursor_scatter_radius;
                        let push = params.cursor_scatter_strength * falloff * falloff;
                        fx += dx / dist * push;
                        fy += dy / dist * push;
                    }
                }
            }
            // soft boundaries: steer back inside when within the margin
            let margin = params.bounds_margin;
            if margin > 0.0 {
                if boid.x < world.min_x + margin {
                    fx += (1.0 - (boid.x - world.min_x) / margin) * params.max_force * 2.0;
                }
                if boid.x > world.max_x - margin {
                    fx -= (1.0 - (world.max_x - boid.x) / margin) * params.max_force * 2.0;
                }
                if boid.y < world.min_y + margin {
                    fy += (1.0 - (boid.y - world.min_y) / margin) * params.max_force * 2.0;
                }
                if boid.y > world.max_y - margin {
                    fy -= (1.0 - (world.max_y - boid.y) / margin) * params.max_force * 2.0;
                }
            }
            // integrate with speed clamps
            let boid = &mut self.boids[i];
            boid.vx += fx;
            boid.vy += fy;
            let speed2 = boid.vx * boid.vx + boid.vy * boid.vy;
            if speed2 > params.max_speed * params.max_speed {
                let scale = params.max_speed / speed2.sqrt();
                boid.vx *= scale;
                boid.vy *= scale;
            } else if speed2 < params.min_speed * params.min_speed && speed2 > 0.0 {
                let scale = params.min_speed / speed2.sqrt();
                boid.vx *= scale;
                boid.vy *= scale;
            }
            boid.x += boid.vx;
            boid.y += boid.vy;
            // hard clamp inside the world (steering can't outrun the clamp)
            boid.x = boid.x.clamp(world.min_x, world.max_x);
            boid.y = boid.y.clamp(world.min_y, world.max_y);
        }
        // no-panic / no-NaN law: sanitize any non-finite state
        for boid in &mut self.boids {
            if !boid.x.is_finite() {
                boid.x = (world.min_x + world.max_x) / 2.0;
            }
            if !boid.y.is_finite() {
                boid.y = (world.min_y + world.max_y) / 2.0;
            }
            if !boid.vx.is_finite() {
                boid.vx = 0.0;
            }
            if !boid.vy.is_finite() {
                boid.vy = 0.0;
            }
        }
    }

    /// Click-to-scatter impulse ("click-to-scatter" — HANDOFF.md §5.10):
    /// agents within `radius` of the point get a velocity kick away from it.
    /// Non-finite point → no-op.
    pub fn scatter(&mut self, x: f64, y: f64, radius: f64, impulse: f64) {
        if !x.is_finite() || !y.is_finite() || !radius.is_finite() || !impulse.is_finite() || radius <= 0.0 {
            return;
        }
        for boid in &mut self.boids {
            let dx = boid.x - x;
            let dy = boid.y - y;
            let dist2 = dx * dx + dy * dy;
            if dist2 < radius * radius && dist2 > 0.0 {
                let dist = dist2.sqrt();
                let falloff = 1.0 - dist / radius;
                let kick = impulse * falloff;
                boid.vx += dx / dist * kick;
                boid.vy += dy / dist * kick;
            }
        }
    }
}

/// Limit a steering vector to `max_force` magnitude; zero-length input
/// returns zero (no NaN).
#[inline]
fn limit_force(x: f64, y: f64, max_force: f64) -> (f64, f64) {
    let magnitude2 = x * x + y * y;
    if magnitude2 == 0.0 || !magnitude2.is_finite() {
        return (0.0, 0.0);
    }
    let magnitude = magnitude2.sqrt();
    if magnitude <= max_force {
        (x, y)
    } else {
        let scale = max_force / magnitude;
        (x * scale, y * scale)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sim(count: usize) -> BoidSim {
        BoidSim::new(42, count, BoidWorld { min_x: 0.0, min_y: 0.0, max_x: 800.0, max_y: 600.0 }, BoidParams::default())
    }

    #[test]
    fn seeded_init_is_deterministic() {
        let a = sim(100);
        let b = sim(100);
        assert_eq!(a.boids.len(), b.boids.len());
        for (pa, pb) in a.boids.iter().zip(b.boids.iter()) {
            assert_eq!(pa.x.to_bits(), pb.x.to_bits());
            assert_eq!(pa.y.to_bits(), pb.y.to_bits());
            assert_eq!(pa.vx.to_bits(), pb.vx.to_bits());
        }
    }

    #[test]
    fn steps_are_deterministic() {
        let mut a = sim(120);
        let mut b = sim(120);
        for _ in 0..50 {
            a.step(None);
            b.step(Some((300.0, 300.0)));
            b.step(None);
        }
        // a and b ran different cursor inputs — compare a against a replay
        let mut a2 = sim(120);
        for _ in 0..50 {
            a2.step(None);
        }
        for (p, p2) in a.boids.iter().zip(a2.boids.iter()) {
            assert_eq!(p.x.to_bits(), p2.x.to_bits(), "same input must replay identically");
        }
    }

    #[test]
    fn agents_stay_inside_world() {
        let mut s = sim(300);
        for _ in 0..200 {
            s.step(Some((400.0, 300.0)));
        }
        for boid in &s.boids {
            assert!(boid.x >= s.world.min_x && boid.x <= s.world.max_x);
            assert!(boid.y >= s.world.min_y && boid.y <= s.world.max_y);
        }
    }

    #[test]
    fn no_nan_over_long_run_with_hostile_cursor() {
        let mut s = sim(200);
        for step in 0..300u32 {
            // hostile cursor inputs: NaN, Infinity, on-agent points
            let cursor = match step % 4 {
                0 => Some((f64::NAN, 100.0)),
                1 => Some((f64::INFINITY, f64::NEG_INFINITY)),
                2 => s.boids.first().map(|b| (b.x, b.y)),
                _ => None,
            };
            s.step(cursor);
        }
        for boid in &s.boids {
            assert!(boid.x.is_finite() && boid.y.is_finite());
            assert!(boid.vx.is_finite() && boid.vy.is_finite());
        }
    }

    #[test]
    fn scatter_kicks_agents_away_from_point() {
        let mut s = sim(1);
        // park the single agent at the scatter origin
        s.boids[0].x = 400.0;
        s.boids[0].y = 300.0;
        s.boids[0].vx = 0.0;
        s.boids[0].vy = 0.0;
        s.scatter(400.0, 300.0, 100.0, 5.0);
        // kicked along +x-ish? direction depends on the offset (0,0) → no-op;
        // place the agent slightly off-center instead.
        let mut s = sim(1);
        s.boids[0].x = 430.0;
        s.boids[0].y = 300.0;
        s.boids[0].vx = 0.0;
        s.boids[0].vy = 0.0;
        s.scatter(400.0, 300.0, 100.0, 5.0);
        assert!(s.boids[0].vx > 0.0, "agent kicked away from scatter point");
        // degenerate: on-point agent unchanged (dist 0 guard)
        let mut s = sim(1);
        s.boids[0].x = 400.0;
        s.boids[0].y = 300.0;
        let vx_before = s.boids[0].vx;
        s.scatter(400.0, 300.0, 100.0, 5.0);
        assert_eq!(s.boids[0].vx, vx_before);
        // non-finite scatter point → no-op
        let mut s = sim(1);
        let before: Vec<(f64, f64, f64, f64)> = s.boids.iter().map(|b| (b.x, b.y, b.vx, b.vy)).collect();
        s.scatter(f64::NAN, 0.0, 100.0, 5.0);
        for (boid, (x, y, vx, vy)) in s.boids.iter().zip(before) {
            assert_eq!((boid.x, boid.y, boid.vx, boid.vy), (x, y, vx, vy), "no-op on NaN");
        }
    }

    #[test]
    fn flocking_pulls_neighbors_into_mixed_motion() {
        // 100 agents from a tight cluster: after steps, they spread out but
        // positions remain distinct (no degenerate collapse to one point).
        let mut s = BoidSim::new(
            7,
            100,
            BoidWorld { min_x: 0.0, min_y: 0.0, max_x: 800.0, max_y: 600.0 },
            BoidParams::default(),
        );
        for boid in &mut s.boids {
            boid.x = 400.0 + (boid.x - 400.0) * 0.05;
            boid.y = 300.0 + (boid.y - 300.0) * 0.05;
        }
        for _ in 0..30 {
            s.step(None);
        }
        let mut min_x = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        for boid in &s.boids {
            min_x = min_x.min(boid.x);
            max_x = max_x.max(boid.x);
        }
        assert!(max_x - min_x > 10.0, "flock spreads out, span {}", max_x - min_x);
    }

    #[test]
    fn spatial_hash_query_matches_brute_force() {
        let world = BoidWorld { min_x: 0.0, min_y: 0.0, max_x: 800.0, max_y: 600.0 };
        let params = BoidParams::default();
        let s = sim(150);
        let mut grid = SpatialHash::new(params.neighbor_radius, &world, s.boids.len());
        for (i, boid) in s.boids.iter().enumerate() {
            grid.insert(boid.x, boid.y, &world, i as u32);
        }
        for (i, boid) in s.boids.iter().enumerate() {
            let mut got = Vec::new();
            grid.query_3x3(boid.x, boid.y, &world, &mut got);
            let expected: Vec<u32> = (0..s.boids.len() as u32)
                .filter(|j| {
                    let other = s.boids[*j as usize];
                    let dx = boid.x - other.x;
                    let dy = boid.y - other.y;
                    dx * dx + dy * dy <= params.neighbor_radius * params.neighbor_radius
                })
                .collect();
            // grid 3×3 must be a SUPERSET of radius matches (cells larger
            // than radius), and every miss must be truly far away
            for j in &got {
                let other = s.boids[*j as usize];
                let dx = boid.x - other.x;
                let dy = boid.y - other.y;
                if dx * dx + dy * dy <= params.neighbor_radius * params.neighbor_radius {
                    assert!(expected.contains(j));
                }
            }
            for j in &expected {
                assert!(got.contains(j), "grid missed agent {j} for agent {i}");
            }
        }
    }

    #[test]
    fn count_clamps_and_bad_world_sanitized() {
        let s = BoidSim::new(1, 9999, BoidWorld { min_x: 0.0, min_y: 0.0, max_x: 10.0, max_y: 10.0 }, BoidParams::default());
        assert_eq!(s.boids.len(), 4096);
        let s = BoidSim::new(
            1,
            10,
            BoidWorld { min_x: f64::NAN, min_y: 0.0, max_x: f64::INFINITY, max_y: 10.0 },
            BoidParams::default(),
        );
        assert_eq!(s.world.width(), 1.0);
        assert_eq!(s.boids.len(), 10);
    }
}
