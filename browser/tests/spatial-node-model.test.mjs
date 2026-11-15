// node --test suite for the pure spatial node-graph model (no Electron).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  LIVE_POOL_LIMIT,
  MAX_LIVE_VIEWS,
  createGraphModel,
  normalizeNode,
  pickEvictionCandidate,
  shouldCaptureNode,
  sessionNodesForTabIds,
  parseSessionNodes,
} = require('../src/main/spatial/node-model.js')

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const node = (over = {}) => ({
  uuid: uuid(1),
  url: 'https://example.test/',
  title: 'Example',
  x: 0,
  y: 0,
  w: 260,
  h: 199,
  parentUuid: null,
  edges: [],
  ...over,
})

test('warm pool constants match the spec (active + 5 = 6 live views)', () => {
  assert.equal(LIVE_POOL_LIMIT, 5)
  assert.equal(MAX_LIVE_VIEWS, 6)
})

test('applyOp add/patch/move keeps normalized records', () => {
  const model = createGraphModel()
  assert.deepEqual(model.applyOp({ type: 'add', node: node() }), { ok: true, changed: true })
  const stored = model.nodes.get(uuid(1))
  assert.equal(stored.url, 'https://example.test/')
  assert.equal(stored.mode, 'reading')
  assert.deepEqual(model.applyOp({ type: 'move', uuid: uuid(1), x: 12.6, y: -3.2 }), { ok: true, changed: true })
  assert.equal(model.nodes.get(uuid(1)).x, 13)
  assert.equal(model.nodes.get(uuid(1)).y, -3)
  model.applyOp({ type: 'patch', uuid: uuid(1), patch: { title: 'Renamed' } })
  assert.equal(model.nodes.get(uuid(1)).title, 'Renamed')
})

test('add clamps hostile coordinates and drops unknown fields', () => {
  const stored = normalizeNode(node({ x: 9e9, y: -9e9, w: -5, evil: 'payload', private: true }))
  assert.equal(stored.x, 1000000)
  assert.equal(stored.y, -1000000)
  assert.equal(stored.w, 0)
  assert.equal(stored.private, true)
  assert.equal('evil' in stored, false)
  // A url-less record is refused outright.
  assert.equal(normalizeNode({ uuid: uuid(9) }), null)
})

test('add links the parent edge; a missing parent becomes a root', () => {
  const model = createGraphModel()
  model.applyOp({ type: 'add', node: node() })
  model.applyOp({ type: 'add', node: node({ uuid: uuid(2), parentUuid: uuid(1) }) })
  assert.deepEqual([...model.nodes.get(uuid(1)).edges], [uuid(2)])
  assert.equal(model.nodes.get(uuid(2)).parentUuid, uuid(1))
  // Parent that does not exist → node is still added, but as a root.
  model.applyOp({ type: 'add', node: node({ uuid: uuid(3), parentUuid: uuid(99) }) })
  assert.equal(model.nodes.get(uuid(3)).parentUuid, null)
})

test('remove re-parents children and clears the parent edge', () => {
  const model = createGraphModel()
  model.applyOp({ type: 'add', node: node() })
  model.applyOp({ type: 'add', node: node({ uuid: uuid(2), parentUuid: uuid(1) }) })
  model.applyOp({ type: 'add', node: node({ uuid: uuid(3), parentUuid: uuid(2) }) })
  model.applyOp({ type: 'remove', uuid: uuid(2) })
  assert.equal(model.nodes.has(uuid(2)), false)
  assert.deepEqual([...model.nodes.get(uuid(1)).edges], [])
  assert.equal(model.nodes.get(uuid(3)).parentUuid, null)
})

test('connect re-parents a node to exactly one parent', () => {
  const model = createGraphModel()
  model.applyOp({ type: 'add', node: node() })
  model.applyOp({ type: 'add', node: node({ uuid: uuid(2) }) })
  model.applyOp({ type: 'add', node: node({ uuid: uuid(3) }) })
  model.applyOp({ type: 'connect', parentUuid: uuid(1), childUuid: uuid(2) })
  model.applyOp({ type: 'connect', parentUuid: uuid(3), childUuid: uuid(2) })
  assert.deepEqual([...model.nodes.get(uuid(1)).edges], [])
  assert.deepEqual([...model.nodes.get(uuid(3)).edges], [uuid(2)])
  assert.equal(model.nodes.get(uuid(2)).parentUuid, uuid(3))
  // Self-edge refused.
  assert.equal(model.applyOp({ type: 'connect', parentUuid: uuid(1), childUuid: uuid(1) }).ok, false)
})

test('applyOps stops at the first rejected op', () => {
  const model = createGraphModel()
  const result = model.applyOps([
    { type: 'add', node: node() },
    { type: 'move', uuid: uuid(7), x: 1, y: 1 },
    { type: 'add', node: node({ uuid: uuid(2) }) },
  ])
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'missing')
  // The op after the failure never ran.
  assert.equal(model.nodes.has(uuid(2)), false)
})

test('duplicate add is refused; unknown op type is refused', () => {
  const model = createGraphModel()
  model.applyOp({ type: 'add', node: node() })
  assert.equal(model.applyOp({ type: 'add', node: node() }).ok, false)
  assert.equal(model.applyOp({ type: 'explode' }).ok, false)
  assert.equal(model.applyOp(null).ok, false)
})

test('pickEvictionCandidate quiets the LRU non-immune node past 6 live views', () => {
  const model = createGraphModel()
  const live = Array.from({ length: 7 }, (_, i) => ({
    uuid: uuid(i + 1),
    tabId: i + 1,
    lastUsedAt: 1000 + i,
    isActive: false,
    isAudible: false,
  }))
  for (let i = 1; i <= 7; i += 1) {
    model.applyOp({ type: 'add', node: node({ uuid: uuid(i), lastActiveAt: 1000 + i }) })
  }
  // 7 live → the oldest, least-recently-used candidate (uuid 1) goes quiet.
  assert.equal(pickEvictionCandidate(live, model), uuid(1))
  // Exactly 6 live → nobody is evicted.
  assert.equal(pickEvictionCandidate(live.slice(1), model), null)
  // The active node is never the candidate.
  const withActive = live.map((entry, i) => ({ ...entry, isActive: i === 0 }))
  assert.equal(pickEvictionCandidate(withActive, model), uuid(2))
})

test('pickEvictionCandidate respects pinned, audible and private immunity', () => {
  const model = createGraphModel()
  for (let i = 1; i <= 7; i += 1) {
    model.applyOp({
      type: 'add',
      node: node({ uuid: uuid(i), lastActiveAt: 1000 + i, pinned: i === 1, private: i === 2 }),
    })
  }
  const live = Array.from({ length: 7 }, (_, i) => ({
    uuid: uuid(i + 1),
    tabId: i + 1,
    lastUsedAt: 1000 + i,
    isActive: false,
    isAudible: i === 0,
  }))
  // uuid 1 pinned, 2 private, 3 would be next by LRU — wait, 3 has lastUsedAt
  // 1002 and no immunity... entries 1 and 2 are immune via node flags and the
  // audible flag respectively, so the oldest evictable one is uuid(4)? No —
  // entry order: tabId 1..7; LRU by lastUsedAt ascending skips 1 (pinned),
  // 2 (private) and the audible entry (tabId 1 = uuid 1). Next oldest: uuid 3.
  assert.equal(pickEvictionCandidate(live, model), uuid(3))
})

test('pickEvictionCandidate returns null when everything is immune', () => {
  const model = createGraphModel()
  for (let i = 1; i <= 7; i += 1) {
    model.applyOp({
      type: 'add',
      node: node({ uuid: uuid(i), lastActiveAt: 1000 + i, pinned: true }),
    })
  }
  const live = Array.from({ length: 7 }, (_, i) => ({
    uuid: uuid(i + 1),
    tabId: i + 1,
    lastUsedAt: 1000 + i,
    isActive: false,
    isAudible: false,
  }))
  assert.equal(pickEvictionCandidate(live, model), null)
  assert.equal(pickEvictionCandidate([], model), null)
  assert.equal(pickEvictionCandidate(null, null), null)
})

test('shouldCaptureNode skips private/noCapture nodes (spec: noCapture class)', () => {
  assert.equal(shouldCaptureNode(node(), {}, { isLive: true }), true)
  assert.equal(shouldCaptureNode(node({ private: true }), {}, { isLive: true }), false)
  assert.equal(shouldCaptureNode(node({ noCapture: true }), {}, { isLive: true }), false)
  // The tab's own privacy also blocks capture even if the node record lagged.
  assert.equal(shouldCaptureNode(node(), { private: true }, { isLive: true }), false)
  // A non-live view is not captureable by default.
  assert.equal(shouldCaptureNode(node(), {}, { isLive: false }), false)
  assert.equal(shouldCaptureNode(node(), {}, { isLive: false, requireLive: false }), true)
})

test('session column round-trips through parseSessionNodes', () => {
  const model = createGraphModel()
  model.applyOp({ type: 'add', node: node() })
  model.applyOp({ type: 'add', node: node({ uuid: uuid(2), parentUuid: uuid(1) }) })
  model.applyOp({ type: 'add', node: node({ uuid: uuid(3) }) })
  const tabIdByUuid = new Map([[uuid(1), 11], [uuid(2), 12]])
  const column = sessionNodesForTabIds(model, [11, 12, 13], tabIdByUuid)
  assert.equal(column.length, 3)
  // The session-v3 record carries the link-branching provenance fields
  // (branchKind/viaAuth/subPages/createdAt) beside the v1 geometry — and the
  // §B.8.4 session partition label (null for ordinary profile-session nodes).
  assert.deepEqual(column[0], {
    uuid: uuid(1), x: 0, y: 0, w: 260, h: 199, parentUuid: null, edges: [uuid(2)],
    branchKind: null, viaAuth: false, partition: null, subPages: [], createdAt: 0,
  })
  assert.deepEqual(column[1], {
    uuid: uuid(2), x: 0, y: 0, w: 260, h: 199, parentUuid: uuid(1), edges: [],
    branchKind: null, viaAuth: false, partition: null, subPages: [], createdAt: 0,
  })
  assert.equal(column[2], null) // tab 13 maps to no spatial node
  // No spatial records at all → null, so the window keeps the v2 shape.
  assert.equal(sessionNodesForTabIds(model, [99], tabIdByUuid), null)
  assert.equal(sessionNodesForTabIds(model, [], tabIdByUuid), null)

  const parsed = parseSessionNodes(column)
  assert.equal(parsed[0].uuid, uuid(1))
  assert.deepEqual(parsed[0].edges, [uuid(2)])
  assert.equal(parsed[2], null)
  // Malformed slots never shift onto a neighbour.
  const hostile = parseSessionNodes([{ uuid: 'not-a-uuid', x: 'x' }, null, column[2]])
  assert.equal(hostile[0], null)
  assert.equal(hostile[1], null)
  assert.equal(hostile[2], null)
})

test('model hydrates from a saved node list and rejects junk', () => {
  const model = createGraphModel([node(), node({ uuid: uuid(2) }), { junk: true }])
  assert.equal(model.nodes.size, 2)
  assert.equal(model.serialize().length, 2)
})
