// spatialCore (Phase 2) — facade contract + backend parity tests.
//
// The Rust spatial engine (crates/spatial-core → vendored
// src/lib/spatial-core-pkg/) is exercised IN Node by passing the .wasm bytes
// straight to initSpatialCore (BufferSource path), so every `facade vs
// *Ts` comparison is a true WASM-vs-TS parity check. If the module cannot
// load here, the facades permanently route to the exact-port TS mirrors and
// the parity assertions simply become TS-vs-TS identity checks — both routes
// must satisfy the same contract, which is exactly what the spec asks the
// Node suite to pin.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  batchFuzzySearch,
  batchFuzzySearchTs,
  createBoidCore,
  createBoidCoreTs,
  createHybridForceCore,
  createHybridForceCoreTs,
  createSpatialCuller,
  createSpatialCullerTs,
  computeMoodboardGridCore,
  computeMoodboardGridTs,
  fuzzyScore,
  getSpatialCoreBackend,
  initSpatialCore,
  scoreGhostEchoes,
  scoreGhostEchoesTs,
  urlHashToNumber,
} from '../src/lib/spatialCore.ts'
import { embedText, cosineSimilarity } from '../src/lib/embed.ts'
import { GHOST_ECHO_THRESHOLD } from '../src/lib/spatialCore.ts'

/* Deterministic test-data PRNG (mulberry32) — no Math.random anywhere. */
function prng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('spatial-core backend initializes (wasm bytes → wasm, else pure-TS fallback)', async () => {
  let backend = getSpatialCoreBackend()
  assert.equal(backend, 'ts', 'before init the facades route to TS')
  try {
    const bytes = readFileSync(new URL('../src/lib/spatial-core-pkg/spatial_core_bg.wasm', import.meta.url))
    backend = await initSpatialCore(bytes)
  } catch (error) {
    backend = await initSpatialCore()
  }
  assert.ok(backend === 'wasm' || backend === 'ts', `backend reported: ${backend}`)
  assert.equal(backend, getSpatialCoreBackend())
  console.log(`[spatialCore.test] backend = ${backend}`)
})

test('cull — facade matches TS mirror over fuzzed boxes and queries', () => {
  const rng = prng(0xc0ffee)
  const boxes = []
  for (let i = 0; i < 300; i++) {
    boxes.push({
      id: i,
      x: Math.round(rng() * 4000 - 500),
      y: Math.round(rng() * 4000 - 500),
      width: Math.round(rng() * 300 + 20),
      height: Math.round(rng() * 200 + 20),
    })
  }
  const facade = createSpatialCuller()
  const mirror = createSpatialCullerTs()
  facade.setBoxes(boxes)
  mirror.setBoxes(boxes)
  assert.equal(facade.len(), mirror.len())
  for (let i = 0; i < 200; i++) {
    const minX = Math.round(rng() * 3600 - 400)
    const minY = Math.round(rng() * 3600 - 400)
    const maxX = minX + Math.round(rng() * 900 + 40)
    const maxY = minY + Math.round(rng() * 700 + 40)
    const margin = Math.round(rng() * 250)
    assert.deepEqual(facade.queryViewport(minX, minY, maxX, maxY, margin), mirror.queryViewport(minX, minY, maxX, maxY, margin))
    const x = rng() * 3800 - 500
    const y = rng() * 3800 - 500
    const px = Math.round(rng() * 300)
    const py = Math.round(rng() * 300)
    assert.equal(facade.hitTest(x, y), mirror.hitTest(x, y), `hitTest ${x},${y}`)
    assert.equal(facade.nearest(x, y), mirror.nearest(x, y), `nearest ${x},${y}`)
    assert.equal(facade.overlapsAny(px, py, 260, 199), mirror.overlapsAny(px, py, 260, 199))
  }
  facade.free()
})

test('cull — golden cases (viewport query, touching edges, invalid input)', () => {
  const culler = createSpatialCullerTs()
  const boxAt = (id, x, y) => ({ id, x, y, width: 260, height: 199 })
  culler.setBoxes([boxAt(7, 0, 0), boxAt(3, 500, 500), boxAt(12, -300, -50), boxAt(1, 9000, 9000)])
  assert.deepEqual(culler.queryViewport(-100, -100, 400, 400, 0), [7, 12])
  assert.deepEqual(culler.queryViewport(-100, -100, 520, 610, 0), [3, 7, 12])
  // touching edges DO count for viewport queries (rstar inclusive envelopes)
  culler.setBoxes([boxAt(1, 0, 0), boxAt(2, 260, 0)])
  assert.deepEqual(culler.queryViewport(259, 10, 261, 20, 0), [1, 2])
  assert.deepEqual(culler.queryViewport(260, 10, 261, 20, 0), [1, 2], 'a rect touching box 1 right edge includes it too')
  // touching edges do NOT overlap for the ghost keep-out probe (strict test,
  // moodboard.ts rectIntersects): probe ends exactly where the card begins
  culler.setBoxes([boxAt(2, 260, 0)])
  assert.equal(culler.overlapsAny(0, 0, 260, 199), false, 'touching edge is not an overlap')
  assert.equal(culler.overlapsAny(260, 0, 10, 199), true)
  assert.equal(culler.overlapsAny(259, 0, 1, 199), false, 'probe ending at the card edge does not overlap')
  assert.equal(culler.overlapsAny(Number.NaN, 0, 10, 10), false, 'non-finite probe → false')
  // smallest card wins the hit-test; id breaks area ties
  culler.setBoxes([boxAt(1, 0, 0), { id: 2, x: 10, y: 10, width: 40, height: 40 }, { id: 3, x: 10, y: 10, width: 40, height: 40 }])
  assert.equal(culler.hitTest(15, 15), 2)
  // invalid boxes are dropped (non-finite / negative size)
  culler.setBoxes([boxAt(1, 0, 0), { id: 9, x: Number.NaN, y: 0, width: 10, height: 10 }, { id: 8, x: 0, y: 0, width: -5, height: 10 }])
  assert.equal(culler.len(), 1)
  assert.deepEqual(culler.queryViewport(Number.NaN, 0, 100, 100, 0), [])
})

test('moodboard — facade matches the pure solver over fuzzed regions', () => {
  const rng = prng(0x9d00d)
  for (let round = 0; round < 40; round++) {
    const count = Math.floor(rng() * 40)
    const nodes = []
    for (let i = 0; i < count; i++) {
      nodes.push({
        uuid: `n${round}-${i}`,
        x: Math.round(rng() * 1600 - 300),
        y: Math.round(rng() * 1200 - 200),
        isPinned: rng() < 0.2,
      })
    }
    const viaFacade = computeMoodboardGridCore(nodes)
    const viaTs = computeMoodboardGridTs(nodes)
    assert.deepEqual(viaFacade, viaTs, `round ${round} (count ${count})`)
  }
})

test('moodboard — canonical defaults survive the facade', () => {
  const nodes = [1, 2, 3, 4].map((i) => ({ uuid: `n${i}`, x: i * 97, y: i * 211, isPinned: false }))
  const result = computeMoodboardGridCore(nodes)
  assert.equal(result.pitchWidth, 384)
  assert.equal(result.pitchHeight, 240)
  assert.equal(result.cardWidth, 260)
  assert.equal(result.cardHeight, 199)
  assert.equal(result.placedCount, 4)
  assert.deepEqual(result.moved, ['n1', 'n2', 'n3', 'n4'])
})

test('search — fuzzy scorer goldens (exact substring beats subsequence)', () => {
  assert.equal(fuzzyScore('fig', 'Figma'), 3 - Math.min(1.5, 0 * 0.02), 'exact at index 0')
  assert.ok(fuzzyScore('fig', 'My Figma Board') < fuzzyScore('fig', 'Figma'), 'later substring scores lower')
  const sub = fuzzyScore('fgm', 'Figma')
  assert.ok(sub >= 0.4 && sub < 3, `subsequence score ${sub} in band`)
  assert.equal(fuzzyScore('xyz', 'Figma'), 0, 'no subsequence → 0')
  assert.equal(fuzzyScore('anything', ''), 0, 'empty haystack → 0')
})

test('search — batch facade matches TS mirror; weights and order pinned', () => {
  const docs = [
    { uuid: 'a', title: 'Figma — Design System', domain: 'figma.com', url: 'https://figma.com/file/a', searchQuery: 'design tokens', keywords: ['ui', 'tokens'] },
    { uuid: 'b', title: 'GitHub PR review', domain: 'github.com', url: 'https://github.com/pr/1', searchQuery: null, keywords: ['code'] },
    { uuid: 'c', title: 'Shadertoy', domain: 'shadertoy.com', url: 'https://shadertoy.com/view/xyz', searchQuery: 'raymarch', keywords: ['webgpu', 'figma'] },
  ]
  const rng = prng(0x5e12c)
  const queries = ['fig', 'tok', 'git', 'ray', 'gpu', 'figma.com', 'XYZ', 'z', '', 'zzz']
  for (let i = 0; i < 20; i++) queries.push(String.fromCharCode(97 + Math.floor(rng() * 26)) + String.fromCharCode(97 + Math.floor(rng() * 26)))
  for (const raw of queries) {
    assert.deepEqual(batchFuzzySearch(raw, docs, 12), batchFuzzySearchTs(raw, docs, 12), `query "${raw}"`)
  }
  // empty query → empty; limit respected; ties keep input order (stable sort)
  assert.deepEqual(batchFuzzySearch('', docs, 12), [])
  const hits = batchFuzzySearchTs('g', docs, 1)
  assert.equal(hits.length, 1)
})

test('ghost — scoring shell matches the store formula and threshold', () => {
  const active = {
    uuid: 'act',
    title: 'Rust WASM Spatial Engine',
    domain: 'rust-lang.org',
    keywords: ['wasm', 'spatial'],
    searchQuery: 'wasm bindgen',
    excerpt: 'Compiling Rust to WebAssembly for deterministic spatial math.',
    urlHash: urlHashToNumber('u00abcdef'),
  }
  const makeCandidate = (uuid, title, domain, keywords, edgeWeight, lastVisitedAt) => ({
    uuid,
    title,
    domain,
    keywords,
    searchQuery: null,
    excerpt: null,
    edgeWeight,
    lastVisitedAt,
    isGhostEcho: false,
    isLive: false,
    urlHash: urlHashToNumber('uffff0000'),
    urlHashSuppressed: false,
  })
  const candidates = [
    makeCandidate('c1', 'WebAssembly in Rust', 'rust-lang.org', ['wasm', 'crate'], 4, 0),
    makeCandidate('c2', 'Totally Unrelated Cooking', 'recipes.net', ['pasta'], 0, 0),
    makeCandidate('c3', 'WASM Bindgen Guide', 'rustwasm.github.io', ['bindgen'], 1, 0),
  ]
  const now = 1_000_000_000_000
  const maxWeight = 4
  const viaFacade = scoreGhostEchoes(active, candidates, maxWeight, now, 10)
  const viaTs = scoreGhostEchoesTs(active, candidates, maxWeight, now, 10)
  assert.deepEqual(viaFacade, viaTs)
  // independent reference implementation of the store formula
  const corpus = (n) => [n.title, n.domain, ...n.keywords, n.searchQuery ?? '', (n.excerpt ?? '').slice(0, 400)].join(' ').trim()
  for (const candidate of candidates) {
    const cosine = cosineSimilarity(embedText(corpus(active)), embedText(corpus(candidate)))
    const coVisit = Math.min(1, candidate.edgeWeight / maxWeight)
    const recency = Math.exp(-Math.max(0, (now - candidate.lastVisitedAt) / 86_400_000) / 14)
    const relevance = 0.55 * cosine + 0.3 * coVisit + 0.15 * recency
    const found = viaTs.find((hit) => hit.uuid === candidate.uuid)
    if (relevance >= GHOST_ECHO_THRESHOLD) {
      assert.ok(found, `candidate ${candidate.uuid} above threshold must be returned`)
      assert.ok(Math.abs(found.relevance - relevance) < 1e-9)
      assert.ok(Math.abs(found.cosine - cosine) < 1e-9)
      assert.ok(Math.abs(found.coVisit - coVisit) < 1e-9)
      assert.ok(Math.abs(found.recency - recency) < 1e-9)
    } else {
      assert.equal(found, undefined, `candidate ${candidate.uuid} below threshold must be filtered`)
    }
  }
  // strongest first
  for (let i = 1; i < viaTs.length; i++) assert.ok(viaTs[i - 1].relevance >= viaTs[i].relevance)
})

test('ghost — filter shell (self, ghost, live, same urlHash, suppressed, limit)', () => {
  const active = { uuid: 'act', title: 'Alpha', domain: 'a.com', keywords: [], searchQuery: null, excerpt: null, urlHash: 1 }
  // Identical corpus to the active node (same title + domain) → cosine 1, so
  // the shell (not weak similarity) is what's under test here.
  const candidate = (uuid, overrides = {}) => ({
    uuid,
    title: 'Alpha',
    domain: 'a.com',
    keywords: [],
    searchQuery: null,
    excerpt: null,
    // The threshold (0.78) is only reachable with a co-visitation edge:
    // max relevance without one is 0.55·cos + 0.15·recency ≤ 0.70.
    edgeWeight: 5,
    lastVisitedAt: 0,
    isGhostEcho: false,
    isLive: false,
    urlHash: 2,
    urlHashSuppressed: false,
    ...overrides,
  })
  const input = [
    candidate('self', { uuid: 'act' }),
    candidate('ghost', { isGhostEcho: true }),
    candidate('live', { isLive: true }),
    candidate('samehash', { urlHash: 1 }),
    candidate('suppressed', { urlHashSuppressed: true }),
    candidate('kept'),
    // no co-visitation edge → coVisit 0 → below threshold even though similar
    candidate('noedge', { edgeWeight: 0 }),
  ]
  const scored = scoreGhostEchoesTs(active, input, 5, 1000, 10)
  assert.deepEqual(scored.map((hit) => hit.uuid), ['kept'])
  assert.deepEqual(scoreGhostEchoes(active, input, 5, 1000, 10), scored)
  // limit caps the strongest-first list
  const many = [1, 2, 3, 4].map((i) => candidate(`k${i}`))
  assert.equal(scoreGhostEchoesTs(active, many, 5, 1000, 2).length, 2)
})

test('boids — seeded determinism, bounds clamp, scatter determinism', () => {
  const world = { minX: 0, minY: 0, maxX: 800, maxY: 600 }
  const a = createBoidCoreTs(42, 120, world)
  const b = createBoidCoreTs(42, 120, world)
  for (let step = 0; step < 80; step++) {
    a.step(400, 300, step % 3 === 0)
    b.step(400, 300, step % 3 === 0)
  }
  const pa = a.positions()
  const pb = b.positions()
  assert.equal(pa.length, pb.length)
  for (let i = 0; i < pa.length; i++) assert.equal(pa[i], pb[i], 'same seed → bit-identical steps')
  for (let i = 0; i < pa.length; i += 2) {
    assert.ok(pa[i] >= 0 && pa[i] <= 800 && pa[i + 1] >= 0 && pa[i + 1] <= 600, 'hard clamp holds')
    assert.ok(Number.isFinite(pa[i]) && Number.isFinite(pa[i + 1]), 'no NaN leaves a step')
  }
  // facade parity against the TS mirror (true WASM check when the backend is wasm)
  const facade = createBoidCore(42, 120, world)
  const ts = createBoidCoreTs(42, 120, world)
  assert.equal(facade.count(), ts.count())
  for (let step = 0; step < 120; step++) {
    facade.step(100 + step, 200, step % 2 === 0)
    ts.step(100 + step, 200, step % 2 === 0)
  }
  const pf = facade.positions()
  const pt = ts.positions()
  for (let i = 0; i < pf.length; i++) {
    assert.ok(Math.abs(pf[i] - pt[i]) < 1e-9, `boid position parity at flat index ${i}: ${pf[i]} vs ${pt[i]}`)
  }
  // scatter kicks agents deterministically
  const c = createBoidCoreTs(7, 60, world)
  const d = createBoidCoreTs(7, 60, world)
  c.scatter(400, 300, 120, 2.5)
  c.step(400, 300, false)
  d.step(400, 300, false)
  const pc = c.positions()
  const pd = d.positions()
  let moved = false
  for (let i = 0; i < pc.length; i++) {
    if (pc[i] !== pd[i]) moved = true
    assert.ok(Math.abs(pc[i] - pd[i]) < 40, 'scatter kick is bounded')
  }
  assert.equal(moved, true, 'scatter changed at least one position')
  facade.free()
})

test('force — pinned anchors never drift; satellites settle; parity vs mirror', () => {
  const nodes = [
    { uuid: 'hub', x: 500, y: 400, fx: 500, fy: 400, isNew: false, radius: 52 },
    { uuid: 'sat', x: 900, y: 900, fx: null, fy: null, isNew: true, radius: 52 },
    { uuid: 'old', x: 300, y: 700, fx: null, fy: null, isNew: false, radius: 52 },
  ]
  const links = [{ source: 'hub', target: 'sat', weight: 1 }]
  const facade = createHybridForceCore(nodes, links)
  const mirror = createHybridForceCoreTs(nodes, links)
  let settled = null
  for (let tick = 0; tick < 400; tick++) {
    const report = facade.tick()
    mirror.tick()
    const alpha = facade.alpha()
    assert.ok(alpha >= 0 && alpha < 1.1, `alpha sane at tick ${tick}: ${alpha}`)
    if (report.settled.length > 0 && settled === null) {
      settled = report.settled.find((event) => event.uuid === 'sat') ?? null
    }
    if (!report.stillRunning && tick > 5) break
  }
  assert.ok(settled, 'the fresh satellite emitted a settle event')
  assert.ok(settled.x > 500 && settled.y < 900, 'satellite relaxed toward its parent, not away')
  const flat = facade.positions()
  const flatMirror = mirror.positions()
  for (let i = 0; i < flat.length; i++) {
    assert.ok(Math.abs(flat[i] - flatMirror[i]) < 1e-6, `force parity at index ${i}: ${flat[i]} vs ${flatMirror[i]}`)
  }
  // pinned anchor never moved
  assert.equal(flat[0], 500)
  assert.equal(flat[1], 400)
  // reheat raises alpha
  facade.reheat(0.5)
  assert.ok(Math.abs(facade.alpha() - 0.5) < 1e-12)
  facade.free()
  mirror.free()
})
