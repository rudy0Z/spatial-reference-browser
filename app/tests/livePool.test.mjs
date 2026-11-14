// §5.2 live-pool unit tests — pure module, no React/Electron.
// Includes the master-spec Phase 1.5 regression: partial evictions must
// STICK even when immune tabs keep the pool nominally over budget.
import test from 'node:test'
import assert from 'node:assert/strict'
import { enforceLivePool, isNodeImmune, LIVE_POOL_LIMIT } from '../src/lib/livePool.ts'

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

test('LIVE_POOL_LIMIT is the canonical 5', () => {
  assert.equal(LIVE_POOL_LIMIT, 5)
})

test('pool under the limit is returned untouched', () => {
  const nodes = poolOf(tab(), tab(), tab())
  const result = enforceLivePool(nodes, null, null)
  assert.equal(result.evicted, null)
  assert.equal(result.nodes, nodes)
})

test('the sixth live tab evicts the least-recently-visited one', () => {
  const a = tab({ lastVisitedAt: 1000 })
  const b = tab({ lastVisitedAt: 2000 })
  const c = tab({ lastVisitedAt: 3000 })
  const d = tab({ lastVisitedAt: 4000 })
  const e = tab({ lastVisitedAt: 5000 })
  const f = tab({ lastVisitedAt: 6000 })
  const result = enforceLivePool(poolOf(a, b, c, d, e, f), null, f.uuid)
  assert.equal(result.evicted.uuid, a.uuid)
  assert.equal(result.nodes[a.uuid].ramState, 'hibernated')
  assert.equal(result.nodes[a.uuid].ramMb, 0)
  assert.equal(result.nodes[f.uuid].ramState, 'live')
})

test('the active node is never evicted, even when oldest', () => {
  const a = tab({ lastVisitedAt: 1000 })
  const b = tab({ lastVisitedAt: 2000 })
  const c = tab({ lastVisitedAt: 3000 })
  const d = tab({ lastVisitedAt: 4000 })
  const e = tab({ lastVisitedAt: 5000 })
  const f = tab({ lastVisitedAt: 6000 })
  const result = enforceLivePool(poolOf(a, b, c, d, e, f), null, a.uuid)
  assert.equal(result.evicted.uuid, b.uuid)
  assert.equal(result.nodes[a.uuid].ramState, 'live')
})

test('audible and pinned tabs are immune', () => {
  assert.equal(isNodeImmune(tab({ isAudible: true }), null), true)
  assert.equal(isNodeImmune(tab({ isPinned: true }), null), true)
  const recorder = tab()
  assert.equal(isNodeImmune(recorder, recorder.uuid), true)
  assert.equal(isNodeImmune(tab()), false)
})

test('REGRESSION: partial eviction sticks when immune tabs keep the pool over budget', () => {
  // 7 live tabs; the two LRU-oldest are immune (pinned, audible). Only 2
  // evictable candidates exist, so `excess` can never reach 0 — the old
  // code returned the ORIGINAL map, silently resurrecting evictions and
  // leaving 7 live tabs over a 5-tab pool.
  const pinned = tab({ uuid: 'pinned', isPinned: true, fx: 0, fy: 0, lastVisitedAt: 1000 })
  const audible = tab({ uuid: 'audible', isAudible: true, lastVisitedAt: 2000 })
  const u3 = tab({ uuid: 'u3', lastVisitedAt: 3000 })
  const u4 = tab({ uuid: 'u4', lastVisitedAt: 4000 })
  const u5 = tab({ uuid: 'u5', lastVisitedAt: 5000 })
  const u6 = tab({ uuid: 'u6', lastVisitedAt: 6000 })
  const u7 = tab({ uuid: 'u7', lastVisitedAt: 7000 })
  const result = enforceLivePool(poolOf(pinned, audible, u3, u4, u5, u6, u7), null, u7.uuid)

  assert.equal(result.evicted.uuid, 'u3')
  assert.equal(result.nodes.u3.ramState, 'hibernated')
  assert.equal(result.nodes.u4.ramState, 'hibernated')
  // The immune + active tabs stay live even though the pool is over budget.
  assert.equal(result.nodes.pinned.ramState, 'live')
  assert.equal(result.nodes.audible.ramState, 'live')
  assert.equal(result.nodes.u7.ramState, 'live')
})

test('recording suspends the sweep entirely', () => {
  const nodes = poolOf(tab(), tab(), tab(), tab(), tab(), tab(), tab())
  const result = enforceLivePool(nodes, 'u-rec', null)
  assert.equal(result.evicted, null)
  assert.equal(result.nodes, nodes)
})
