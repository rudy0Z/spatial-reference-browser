// §5.2 / §B.6 live-pool unit tests — pure module, no React/Electron.
// ADDENDUM B semantics: the hard LIVE_POOL_LIMIT = 5 is replaced by the
// user-configurable performanceGuardrail (default maxLiveSessionTabs: 25,
// idle hibernation 60 min, optional RAM ceiling), with audible-tabs keeping
// a 2.5 s pause debounce. The Phase 1.5 regression — partial evictions must
// STICK even when immune tabs keep the pool nominally over budget — carries
// over verbatim.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AUDIO_PAUSE_DEBOUNCE_MS,
  DEFAULT_PERFORMANCE_GUARDRAIL,
  MAX_LIVE_TABS_MAX,
  MAX_LIVE_TABS_MIN,
  enforceLivePool,
  enforceRamCeiling,
  hibernateIdleNodes,
  isNodeImmune,
  normalizeGuardrail,
} from '../src/lib/livePool.ts'

let seq = 0
function tab(overrides = {}) {
  seq += 1
  return {
    uuid: `u${seq}`,
    urlHash: `h${seq}`,
    url: `https://example.com/${seq}`,
    domain: 'example.com',
    title: `Tab ${seq}`,
    regionId: null,
    nodeType: 'tab',
    ramState: 'live',
    ramMb: 100,
    isAudible: false,
    isPinned: false,
    isLoading: false,
    noCapture: false,
    ephemeral: false,
    viaAuth: false,
    searchQuery: null,
    subPages: [],
    excerpt: null,
    keywords: [],
    parentUuid: null,
    ghostOfUuid: null,
    ghostTetherUuid: null,
    ghostMatch: null,
    settled: true,
    visitCount: 1,
    lastVisitedAt: seq * 1000,
    createdAt: 0,
    x: 0,
    y: 0,
    fx: null,
    fy: null,
    ...overrides,
  }
}

function poolOf(...tabs) {
  return Object.fromEntries(tabs.map((t) => [t.uuid, t]))
}

function poolOfN(n, startLastVisitedAt = 1000) {
  const tabs = []
  for (let i = 0; i < n; i += 1) tabs.push(tab({ lastVisitedAt: startLastVisitedAt + i * 1000 }))
  return tabs
}

test('the default guardrail is 25 live tabs / 60-minute idle park / no RAM ceiling', () => {
  assert.equal(DEFAULT_PERFORMANCE_GUARDRAIL.maxLiveSessionTabs, 25)
  assert.equal(DEFAULT_PERFORMANCE_GUARDRAIL.idleHibernateMinutes, 60)
  assert.equal(DEFAULT_PERFORMANCE_GUARDRAIL.ramCeilingMb, undefined)
})

test('user bounds: maxLiveSessionTabs clamps to 5..100, "unlimited" passes through', () => {
  assert.equal(MAX_LIVE_TABS_MIN, 5)
  assert.equal(MAX_LIVE_TABS_MAX, 100)
  assert.equal(normalizeGuardrail({ maxLiveSessionTabs: 0 }).maxLiveSessionTabs, 5)
  assert.equal(normalizeGuardrail({ maxLiveSessionTabs: 3 }).maxLiveSessionTabs, 5)
  assert.equal(normalizeGuardrail({ maxLiveSessionTabs: 42 }).maxLiveSessionTabs, 42)
  assert.equal(normalizeGuardrail({ maxLiveSessionTabs: 1000 }).maxLiveSessionTabs, 100)
  assert.equal(normalizeGuardrail({ maxLiveSessionTabs: 'unlimited' }).maxLiveSessionTabs, 'unlimited')
  assert.equal(normalizeGuardrail({ maxLiveSessionTabs: 'bogus' }).maxLiveSessionTabs, 25)
})

test('idleHibernateMinutes accepts 15/30/60/"never" and falls back to 60', () => {
  assert.equal(normalizeGuardrail({ idleHibernateMinutes: 15 }).idleHibernateMinutes, 15)
  assert.equal(normalizeGuardrail({ idleHibernateMinutes: 30 }).idleHibernateMinutes, 30)
  assert.equal(normalizeGuardrail({ idleHibernateMinutes: 'never' }).idleHibernateMinutes, 'never')
  assert.equal(normalizeGuardrail({ idleHibernateMinutes: 45 }).idleHibernateMinutes, 60)
  assert.equal(normalizeGuardrail({}).idleHibernateMinutes, 60)
})

test('ramCeilingMb is kept when finite and positive, dropped otherwise', () => {
  assert.equal(normalizeGuardrail({ ramCeilingMb: 2048 }).ramCeilingMb, 2048)
  assert.equal(normalizeGuardrail({ ramCeilingMb: 0 }).ramCeilingMb, undefined)
  assert.equal(normalizeGuardrail({ ramCeilingMb: -5 }).ramCeilingMb, undefined)
  assert.equal(normalizeGuardrail({ ramCeilingMb: 'lots' }).ramCeilingMb, undefined)
})

test('a pool under the guardrail is returned untouched', () => {
  const nodes = poolOf(...poolOfN(10))
  const result = enforceLivePool(nodes, null, null)
  assert.equal(result.evicted, null)
  assert.equal(result.nodes, nodes)
})

test('the 26th live tab evicts the least-recently-visited one (25 default)', () => {
  const tabs = poolOfN(26)
  const active = tabs[25]
  const oldest = tabs[0]
  const result = enforceLivePool(poolOf(...tabs), null, active.uuid)
  assert.equal(result.evicted.uuid, oldest.uuid)
  assert.equal(result.nodes[oldest.uuid].ramState, 'hibernated')
  assert.equal(result.nodes[oldest.uuid].ramMb, 0)
  assert.equal(result.nodes[active.uuid].ramState, 'live')
  const liveCount = Object.values(result.nodes).filter((n) => n.ramState === 'live').length
  assert.equal(liveCount, 25)
})

test('a custom maxLiveSessionTabs still works (5)', () => {
  const tabs = poolOfN(6)
  const result = enforceLivePool(poolOf(...tabs), null, tabs[5].uuid, { maxLiveSessionTabs: 5, idleHibernateMinutes: 'never' })
  assert.equal(result.evicted.uuid, tabs[0].uuid)
})

test("'unlimited' never evicts, no matter how many live tabs exist", () => {
  const nodes = poolOf(...poolOfN(40))
  const result = enforceLivePool(nodes, null, null, { maxLiveSessionTabs: 'unlimited', idleHibernateMinutes: 60 })
  assert.equal(result.evicted, null)
  assert.equal(result.nodes, nodes)
})

test('the active node is never evicted, even when oldest', () => {
  const tabs = poolOfN(26)
  const oldest = tabs[0]
  const result = enforceLivePool(poolOf(...tabs), null, oldest.uuid)
  assert.equal(result.evicted.uuid, tabs[1].uuid)
  assert.equal(result.nodes[oldest.uuid].ramState, 'live')
})

test('audible, pinned and recording tabs are immune', () => {
  assert.equal(isNodeImmune(tab({ isAudible: true }), null), true)
  assert.equal(isNodeImmune(tab({ isPinned: true }), null), true)
  const recorder = tab()
  assert.equal(isNodeImmune(recorder, recorder.uuid), true)
  assert.equal(isNodeImmune(tab()), false)
})

test('§B.6 audio-pause debounce: immunity lingers 2.5 s past a pause, then expires', () => {
  const now = 1_000_000
  const justPaused = tab()
  const pausedAWhile = tab()
  const pausedAt = { [justPaused.uuid]: now - 1000, [pausedAWhile.uuid]: now - AUDIO_PAUSE_DEBOUNCE_MS - 1 }
  assert.equal(isNodeImmune(justPaused, null, pausedAt, now), true)
  assert.equal(isNodeImmune(pausedAWhile, null, pausedAt, now), false)
  // At exactly the boundary the debounce has elapsed.
  const boundary = tab()
  assert.equal(isNodeImmune(boundary, null, { [boundary.uuid]: now - AUDIO_PAUSE_DEBOUNCE_MS }, now), false)
})

test('the pause debounce protects a just-paused tab inside the eviction sweep', () => {
  const tabs = poolOfN(26)
  const oldest = tabs[0]
  const now = Date.now()
  const result = enforceLivePool(
    poolOf(...tabs),
    null,
    tabs[25].uuid,
    DEFAULT_PERFORMANCE_GUARDRAIL,
    { [oldest.uuid]: now - 500 },
  )
  // The oldest is immune (paused 0.5 s ago) — the sweep evicts the NEXT oldest.
  assert.equal(result.evicted.uuid, tabs[1].uuid)
  assert.equal(result.nodes[oldest.uuid].ramState, 'live')
})

test('REGRESSION: partial eviction sticks when immune tabs keep the pool over budget', () => {
  // 27 live tabs (2 over the 25 default); the two LRU-oldest are immune
  // (pinned, audible). Only evictable candidates fill 2 slots, so `excess`
  // reaches 0 here — but with MORE immune tabs than excess, the sweep must
  // still return the partial result instead of the original map.
  const pinned = tab({ uuid: 'pinned', isPinned: true, fx: 0, fy: 0, lastVisitedAt: 1000 })
  const audible = tab({ uuid: 'audible', isAudible: true, lastVisitedAt: 2000 })
  const filler = []
  for (let i = 0; i < 25; i += 1) filler.push(tab({ uuid: `f${i}`, lastVisitedAt: 3000 + i * 1000 }))
  const result = enforceLivePool(poolOf(pinned, audible, ...filler), null, 'f24')

  assert.equal(result.evicted.uuid, 'f0')
  assert.equal(result.nodes.f0.ramState, 'hibernated')
  assert.equal(result.nodes.f1.ramState, 'hibernated')
  // The immune + active tabs stay live even though the pool is over budget.
  assert.equal(result.nodes.pinned.ramState, 'live')
  assert.equal(result.nodes.audible.ramState, 'live')
  assert.equal(result.nodes.f24.ramState, 'live')
})

test('REGRESSION (harder): all excess candidates immune → original map returned, nothing half-evicted', () => {
  // 27 live tabs where the 2 oldest are immune and only 0 evictable tabs
  // exist beyond them (25 immune in the middle): the sweep must not
  // resurrect or half-apply.
  const pinned = tab({ uuid: 'pinned', isPinned: true, lastVisitedAt: 1000 })
  const audible = tab({ uuid: 'audible', isAudible: true, lastVisitedAt: 2000 })
  const rest = []
  for (let i = 0; i < 25; i += 1) rest.push(tab({ uuid: `r${i}`, isPinned: true, lastVisitedAt: 3000 + i * 1000 }))
  const nodes = poolOf(pinned, audible, ...rest)
  const result = enforceLivePool(nodes, null, 'r24')
  assert.equal(result.evicted, null)
  assert.equal(result.nodes, nodes)
})

test('recording suspends the sweep entirely', () => {
  const nodes = poolOf(...poolOfN(30))
  const result = enforceLivePool(nodes, 'u-rec', null)
  assert.equal(result.evicted, null)
  assert.equal(result.nodes, nodes)
})

/* ------------------------------------------------------------------ */
/* §B.6 idle hibernation                                                */
/* ------------------------------------------------------------------ */

const NEVER_GUARDRAIL = { maxLiveSessionTabs: 25, idleHibernateMinutes: 'never' }

test('idle hibernation parks tabs untouched past the window, skipping active + immune', () => {
  const now = 10_000_000
  const twoHoursIdle = tab({ uuid: 'idle', lastVisitedAt: now - 2 * 60 * 60 * 1000 })
  const fiveMinIdle = tab({ uuid: 'fresh', lastVisitedAt: now - 5 * 60 * 1000 })
  const pinnedIdle = tab({ uuid: 'pinned', isPinned: true, lastVisitedAt: now - 5 * 60 * 60 * 1000 })
  const audibleIdle = tab({ uuid: 'audible', isAudible: true, lastVisitedAt: now - 5 * 60 * 60 * 1000 })
  const activeIdle = tab({ uuid: 'active', lastVisitedAt: now - 5 * 60 * 60 * 1000 })
  const alreadyAsleep = tab({ uuid: 'asleep', ramState: 'hibernated', ramMb: 0, lastVisitedAt: now - 9 * 60 * 60 * 1000 })

  const result = hibernateIdleNodes(
    poolOf(twoHoursIdle, fiveMinIdle, pinnedIdle, audibleIdle, activeIdle, alreadyAsleep),
    60,
    now,
    'active',
    null,
  )
  assert.equal(result.parked, 1)
  assert.equal(result.nodes.idle.ramState, 'hibernated')
  assert.equal(result.nodes.idle.ramMb, 0)
  assert.equal(result.nodes.fresh.ramState, 'live')
  assert.equal(result.nodes.pinned.ramState, 'live')
  assert.equal(result.nodes.audible.ramState, 'live')
  assert.equal(result.nodes.active.ramState, 'live')
  assert.equal(result.nodes.asleep.ramState, 'hibernated')
})

test("'never' and recording suspend the idle sweep", () => {
  const now = 10_000_000
  const stale = tab({ uuid: 'stale', lastVisitedAt: now - 9 * 60 * 60 * 1000 })
  const nodes = poolOf(stale)
  assert.deepEqual(hibernateIdleNodes(nodes, 'never', now, null, null), { nodes, parked: 0 })
  const recording = hibernateIdleNodes(nodes, 60, now, null, stale.uuid)
  assert.equal(recording.parked, 0)
  assert.equal(recording.nodes, nodes)
})

test('the audio-pause debounce protects a just-paused tab from the idle sweep', () => {
  const now = 10_000_000
  const justPaused = tab({ uuid: 'paused', lastVisitedAt: now - 9 * 60 * 60 * 1000 })
  const result = hibernateIdleNodes(
    poolOf(justPaused),
    60,
    now,
    null,
    null,
    { [justPaused.uuid]: now - 1000 },
  )
  assert.equal(result.parked, 0)
  assert.equal(result.nodes.paused.ramState, 'live')
})

/* ------------------------------------------------------------------ */
/* §B.6 optional RAM ceiling                                            */
/* ------------------------------------------------------------------ */

test('the RAM ceiling evicts LRU tabs until back under budget', () => {
  const a = tab({ uuid: 'a', ramMb: 300, lastVisitedAt: 1000 })
  const b = tab({ uuid: 'b', ramMb: 300, lastVisitedAt: 2000 })
  const c = tab({ uuid: 'c', ramMb: 300, lastVisitedAt: 3000 })
  const result = enforceRamCeiling(poolOf(a, b, c), null, 'c', 700)
  // Total 900 > 700 → evict the oldest (300) → 600 ≤ 700. Done.
  assert.equal(result.evicted.uuid, 'a')
  assert.equal(result.nodes.a.ramState, 'hibernated')
  assert.equal(result.nodes.b.ramState, 'live')
  assert.equal(result.nodes.c.ramState, 'live')
})

test('the RAM ceiling never touches immune or active tabs', () => {
  const pinned = tab({ uuid: 'pinned', isPinned: true, ramMb: 400, lastVisitedAt: 1000 })
  const audible = tab({ uuid: 'audible', isAudible: true, ramMb: 400, lastVisitedAt: 2000 })
  const nodes = poolOf(pinned, audible)
  const result = enforceRamCeiling(nodes, null, 'audible', 1)
  assert.equal(result.evicted, null)
  assert.equal(result.nodes, nodes)
  assert.equal(result.nodes.pinned.ramState, 'live')
  assert.equal(result.nodes.audible.ramState, 'live')
})

test('recording suspends the RAM ceiling sweep', () => {
  const a = tab({ uuid: 'a', ramMb: 900, lastVisitedAt: 1000 })
  const nodes = poolOf(a)
  const result = enforceRamCeiling(nodes, 'a', null, 1)
  assert.equal(result.evicted, null)
  assert.equal(result.nodes, nodes)
})
