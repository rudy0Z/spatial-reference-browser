// TEMP profiling harness — measures solver build vs tick stages.
use spatial_core::force::{ForceLinkInput, ForceNodeInput, HybridForceSolver};
use std::time::Instant;

fn lcg(seed: u32) -> impl FnMut() -> f64 {
    let mut s = seed.max(1);
    move || {
        s = 1664525u32.wrapping_mul(s).wrapping_add(1013904223);
        f64::from(s) / 4294967296.0
    }
}

#[test]
fn profile_force_stages() {
    let n = 1000;
    let mut rng = lcg(20261115);
    let mut nodes = Vec::new();
    for i in 0..n {
        let x = rng() * 6000.0 - 1000.0;
        let y = rng() * 4500.0 - 800.0;
        nodes.push(ForceNodeInput {
            uuid: format!("n{i}"),
            x, y,
            fx: if i % 50 == 0 { Some(x) } else { None },
            fy: if i % 50 == 0 { Some(y) } else { None },
            is_new: i % 10 == 0,
            radius: 16.0,
        });
    }
    let mut links = Vec::new();
    for i in 0..n - 1 {
        links.push(ForceLinkInput { source: i, target: i + 1, weight: 1.0 + (i % 4) as f64 });
    }
    for i in 0..n / 10 {
        links.push(ForceLinkInput { source: i, target: (i * 37 + 11) % n, weight: 2.0 });
    }
    let start = Instant::now();
    let mut solver = HybridForceSolver::new(nodes, &links);
    let build = start.elapsed();
    let mut ticks = Vec::new();
    for _ in 0..10 {
        let t = Instant::now();
        let report = solver.tick();
        ticks.push((t.elapsed(), report.still_running, report.settled.len()));
    }
    println!("build: {build:?}");
    for (i, (d, running, settled)) in ticks.iter().enumerate() {
        println!("tick {i}: {d:?} running={running} settled={settled}");
    }
}
