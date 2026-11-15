// Node smoke test for the wasm-pack build (pkg/, --target web).
// The web target accepts BufferSource bytes, which sidesteps Node's lack of
// file:// fetch. Exercises every exported surface, asserts sane results,
// exits non-zero on any failure. Run: node scripts/smoke_wasm.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import __wbg_init from "../pkg/spatial_core.js";
import {
  SpatialCuller, HybridForceCore, BoidCore,
  moodboard_grid, batch_fuzzy_search_js, score_ghost_echoes_js,
} from "../pkg/spatial_core.js";

const here = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(join(here, "..", "pkg", "spatial_core_bg.wasm"));
const fail = (m) => { console.error("SMOKE FAIL: " + m); process.exit(1); };

await __wbg_init({ module_or_path: wasmBytes });

// 1. R-tree viewport culler
{
  const c = new SpatialCuller();
  c.set_boxes([
    { id: 0, x: 0, y: 0, width: 100, height: 80 },
    { id: 1, x: 500, y: 500, width: 100, height: 80 },
    { id: 2, x: 50, y: 50, width: 100, height: 80 },
  ]);
  const hit = Array.from(c.query_viewport(0, 0, 200, 200, 0));
  if (JSON.stringify(hit) !== JSON.stringify([0, 2])) fail("query_viewport got " + JSON.stringify(hit));
  const n = c.nearest(400, 400);
  if (n !== 1) fail("nearest expected id 1, got " + n);
  if (c.hit_test(60, 60) !== 0 && c.hit_test(60, 60) !== 2) fail("hit_test 60,60 → " + c.hit_test(60, 60));
  if (c.overlaps_any(95, 10, 20, 20) !== true) fail("overlaps_any strict-overlap must be true");
  if (c.overlaps_any(100, 0, 50, 50) !== false) fail("edge-touch must not count as strict overlap");
  if (c.len() !== 3) fail("len");
  c.free();
}

// 2. Moodboard contact-sheet solver — structural invariants (the exact
// bit-for-bit TS parity is proven by tests/golden_moodboard.rs)
{
  const nodes = Array.from({ length: 12 }, (_, i) => ({ uuid: "u" + i, x: i * 30, y: -i * 30, isPinned: i === 11 }));
  const out = moodboard_grid(nodes, { maxColumns: 2 });
  const pos = Object.fromEntries(out.positions.map(([u, p]) => [u, p]));
  // insets 62/20.5 + pitch 384/240: every unpinned slot sits on the
  // origin-relative lattice (grid origin adapts to the input's centroid)
  const INSET_X = 62, INSET_Y = 20.5, PITCH_W = 384, PITCH_H = 240;
  const ox = out.origin[0], oy = out.origin[1];
  const slots = new Set();
  for (let i = 0; i < 11; i++) {
    const [x, y] = pos["u" + i];
    const okX = Number.isFinite(x) && ((x - ox - INSET_X) / PITCH_W) % 1 === 0;
    const okY = Number.isFinite(y) && ((y - oy - INSET_Y) / PITCH_H) % 1 === 0;
    if (!okX || !okY) fail(`moodboard slot for u${i} = (${x},${y}) is not on the origin(${ox},${oy})+384×240/62/20.5 lattice`);
    const key = `${x},${y}`;
    if (slots.has(key)) fail("two unpinned nodes share slot " + key);
    slots.add(key);
  }
  const pp = pos["u11"];
  if (pp[0] !== 330 || pp[1] !== -330) fail("pinned node must keep its exact position, got " + JSON.stringify(pp));
  if (out.pitchWidth !== 384 || out.pitchHeight !== 240 || out.cardWidth !== 260 || out.cardHeight !== 199) {
    fail("moodboard dims: " + JSON.stringify([out.pitchWidth, out.pitchHeight, out.cardWidth, out.cardHeight]));
  }
  if (!out.unplaced || out.unplaced.length !== 0) fail("unplaced: " + JSON.stringify(out.unplaced));
}

// 3. Batch fuzzy search
{
  const docs = [
    { uuid: "a", title: "GitHub Pull Requests", domain: "github.com", url: "https://github.com/pulls", keywords: [] },
    { uuid: "b", title: "Rust Book Ownership", domain: "doc.rust-lang.org", url: "https://doc.rust-lang.org/book/ch04-00.html", keywords: ["rust"] },
    { uuid: "c", title: "YouTube", domain: "youtube.com", url: "https://youtube.com", keywords: [] },
  ];
  const res = batch_fuzzy_search_js("githb", docs, 10);
  if (!res || res.length !== 1 || res[0].uuid !== "a") fail("fuzzy 'githb' → " + JSON.stringify(res));
  // score is fuzzy·weight (not normalized to ≤1) — must be finite and positive
  if (!(res[0].score > 0) || !Number.isFinite(res[0].score)) fail("fuzzy score range: " + res[0].score);
  if (batch_fuzzy_search_js("", docs, 10).length !== 0) fail("empty query must return []");
}

// 4. Ghost Echo scorer
{
  const active = { uuid: "act", title: "GitHub Pull Requests", domain: "github.com", keywords: ["github", "pulls"], urlHash: 111 };
  const cands = [{
    uuid: "c1", title: "GitHub Pull Requests", domain: "github.com", keywords: ["github", "pulls"],
    urlHash: 222, urlHashSuppressed: false, isGhostEcho: false, isLive: false,
    edgeWeight: 3, lastVisitedAt: 1000 + 36e5 * 24,
  }];
  // NOTE: a candidate with the SAME urlHash as active is filtered out (useGraphStore.ts:406-411), as is a suppressed hash.
  const sameHash = score_ghost_echoes_js(active, [{ ...cands[0], urlHash: 111 }], 3, 1000 + 36e5 * 24, 5);
  if (sameHash.length !== 0) fail("same-urlHash candidate must be filtered out");
  const suppressed = score_ghost_echoes_js(active, [{ ...cands[0], urlHashSuppressed: true }], 3, 1000 + 36e5 * 24, 5);
  if (suppressed.length !== 0) fail("suppressed-urlHash candidate must be filtered out");
  const live = score_ghost_echoes_js(active, [{ ...cands[0], isLive: true }], 3, 1000 + 36e5 * 24, 5);
  if (live.length !== 0) fail("live node must be filtered out");
  const out = score_ghost_echoes_js(active, cands, 3, 1000 + 36e5 * 24, 5);
  if (!out || out.length !== 1) fail("ghost echoes expected 1, got " + JSON.stringify(out));
  // 0.55·cos(=1) + 0.30·coVisit(=1) + 0.15·recency(=1) = 1.0
  if (out[0].relevance < 0.78) fail("strong candidate must clear 0.78 threshold, got " + out[0].relevance);
  if (Math.abs(out[0].cosine - 1) > 1e-9) fail("identical corpus cosine should be 1, got " + out[0].cosine);
}

// 5. Hybrid force relaxer (locked anchors + satellites)
{
  const nodes = [
    { uuid: "anchor", x: 100, y: 200, fx: 100, fy: 200, isNew: false, radius: 10 },
    { uuid: "sat", x: 900, y: -50, isNew: true, radius: 10 },
  ];
  const links = [{ source: 0, target: 1, weight: 1 }];
  const sim = new HybridForceCore(nodes, links);
  const before = sim.positions();
  let sawSettle = false;
  for (let i = 0; i < 400 && !sawSettle; i++) {
    sim.tick();
    const r = sim.tick(); // two ticks so the report reflects motion
    if (r.settled?.some((s) => s.uuid === "sat")) sawSettle = true;
  }
  const after = sim.positions();
  if (before[0] !== after[0] || before[1] !== after[1]) fail("locked anchor (fx/fy) drifted: " + before[0] + "," + before[1] + " → " + after[0] + "," + after[1]);
  if (!sawSettle) fail("satellite never settled");
  // forces acted on the satellite (moved from spawn) and everything is finite;
  // exact equilibrium bands are covered by the force unit tests.
  const moved = Math.hypot(after[2] - 900, after[3] - -50);
  if (!(moved > 50)) fail("satellite never moved (forces did not act), moved " + moved);
  for (const v of after) if (!Number.isFinite(v)) fail("non-finite force position");
  sim.reheat(0.8);
  if (sim.alpha() <= 0) fail("reheat");
  sim.free();
}

// 6. Boids
{
  const b = new BoidCore(42, 200, 0, 0, 800, 600, null);
  b.step(100, 100, true);
  const p = b.positions();
  if (p.length !== 200 * 2) fail("boids positions length");
  for (let i = 0; i < p.length; i++) {
    if (!Number.isFinite(p[i])) fail("boid position NaN at " + i);
  }
  b.scatter(400, 300, 60, 5);
  b.step(400, 300, true);
  b.free();
}

console.log("SMOKE OK — all 6 wasm surfaces exercised (culler, moodboard, fuzzy, ghost-echo, force, boids)");
