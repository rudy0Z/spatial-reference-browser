// node --test suite for the local MCP bridge (Phase 3.7, spec ADDENDUM +
// hardening notes). Pure handler parts only — no Electron:
//   1. bearer-token rejection (helper level AND a real 127.0.0.1 round trip)
//   2. noCapture / viaAuth / private stripping across every read tool
//   3. url_hash dedupe for branch_hibernated_nodes
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  createMcpCore,
  createHttpServer,
  generateBridgeToken,
  bearerFromHeaders,
  tokenMatches,
  stripReason,
  searchGraph,
  planBranch,
  sanitizeNodeRecord,
  normalizeShellState,
  urlHashOf,
  TOOL_DESCRIPTORS,
} = require('../src/main/mcp-server.js')

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const baseNode = (overrides = {}) => ({
  uuid: uuid(1),
  url: 'https://example.com/article',
  title: 'Example article',
  x: 0,
  y: 0,
  parentUuid: null,
  edges: [],
  mode: 'reading',
  pinned: false,
  private: false,
  nodeType: null,
  createdAt: 1000,
  lastActiveAt: 2000,
  thumb: 'data:image/webp;base64,THUMB-BYTES',
  ...overrides,
})

/** One stub snapshot: two live nodes + two hibernated, one excluded trio. */
function stubSnapshot(overrides = {}) {
  return {
    nodes: [
      // main-model shape: parent records carry their children in `edges`
      baseNode({ uuid: uuid(1), url: 'https://are.na/board', title: 'Are.na board', edges: [uuid(2), uuid(3), uuid(4)] }),
      baseNode({ uuid: uuid(2), url: 'https://are.na/board/2', title: 'Are.na board 2', parentUuid: uuid(1) }),
      baseNode({ uuid: uuid(3), url: 'https://klim.co.nz/soehne', title: 'Klim Söhne specimen', parentUuid: uuid(1) }),
      // excluded: viaAuth child with its own child — the whole subtree must vanish
      baseNode({ uuid: uuid(4), url: 'https://accounts.google.com/oauth', title: 'OAuth', parentUuid: uuid(1), viaAuth: true, edges: [uuid(5)] }),
      baseNode({ uuid: uuid(5), url: 'https://g.co/next', title: 'G next', parentUuid: uuid(4) }),
      // excluded: noCapture node
      baseNode({ uuid: uuid(6), url: 'https://bank.example/statement', title: 'Statement', noCapture: true }),
      // excluded: private node
      baseNode({ uuid: uuid(7), url: 'https://private.example/inbox', title: 'Inbox', private: true }),
    ],
    liveUuids: new Set([uuid(1), uuid(2)]),
    activeUuid: uuid(1),
    excerpts: new Map([[uuid(3), 'Söhne is a grotesque family.']]),
    notes: [
      { id: 'note-1', urlHash: urlHashOf('https://are.na/board'), text: 'palette reference', createdAt: 5, updatedAt: 6 },
    ],
    regions: [{ id: 'region-1', name: 'Type research', color: '#88aaff' }],
    ...overrides,
  }
}

const stubEffects = (snapshot = stubSnapshot(), captured = {}) => ({
  graphSnapshot: () => snapshot,
  branchHibernated: async (input) => {
    captured.branchCalls = [...(captured.branchCalls ?? []), input]
    return {
      ok: true,
      created: (input.children ?? []).map((child, i) => baseNode({
        uuid: uuid(90 + i),
        url: child.url,
        title: child.title,
        x: child.x,
        y: child.y,
        parentUuid: child.parentUuid,
        nodeType: child.nodeType,
      })),
    }
  },
  shellCommand: async (input) => {
    captured.shellCommands = [...(captured.shellCommands ?? []), input]
    if (input.action === 'addStickyNote') return { ok: true, noteId: 'note-new' }
    return { ok: true }
  },
})

/* ------------------------------------------------------------------ */
/* 1. Bearer token                                                     */
/* ------------------------------------------------------------------ */

test('bearer token: 256-bit, url-safe, unique per call', () => {
  const a = generateBridgeToken()
  const b = generateBridgeToken()
  assert.equal(a.length, 43)
  assert.match(a, /^[A-Za-z0-9_-]+$/)
  assert.notEqual(a, b)
})

test('bearer token: header parsing accepts only the Bearer scheme', () => {
  assert.equal(bearerFromHeaders({ authorization: 'Bearer abc' }), 'abc')
  assert.equal(bearerFromHeaders({ authorization: 'Bearer\ttab-token' }), 'tab-token')
  assert.equal(bearerFromHeaders({ authorization: 'bearer lower' }), 'lower')
  assert.equal(bearerFromHeaders({ authorization: 'Basic abc' }), null)
  assert.equal(bearerFromHeaders({}), null)
  assert.equal(bearerFromHeaders(null), null)
})

test('bearer token: constant-time compare rejects wrong/missing/malformed', () => {
  const token = generateBridgeToken()
  assert.equal(tokenMatches(token, token), true)
  assert.equal(tokenMatches('not-the-token', token), false)
  assert.equal(tokenMatches('', token), false)
  assert.equal(tokenMatches(undefined, token), false)
  assert.equal(tokenMatches(token, undefined), false)
  assert.equal(tokenMatches(null, null), false)
})

test('http transport: every call without the exact bearer is rejected', async () => {
  const core = createMcpCore(stubEffects())
  const token = generateBridgeToken()
  const server = createHttpServer({ core, token })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const post = (headers, body) => new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/',
        headers: { 'content-type': 'application/json', ...headers },
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      })
      req.on('error', reject)
      req.end(body ?? '')
    })

    // missing token
    const noAuth = await post({}, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    assert.equal(noAuth.status, 401)
    assert.equal(noAuth.body.includes('token'), false, 'error body must not hint at the token')

    // wrong token
    const badAuth = await post({ authorization: `Bearer ${generateBridgeToken()}` }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    assert.equal(badAuth.status, 401)

    // a valid token gets through and lists exactly the six tools
    const ok = await post({ authorization: `Bearer ${token}` }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    assert.equal(ok.status, 200)
    const parsed = JSON.parse(ok.body)
    assert.equal(parsed.result.tools.length, 6)

    // non-POST and unknown paths never reach the core
    assert.equal((await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
    })), 405)
    assert.equal((await post({ authorization: `Bearer ${token}` }, '{}', )).status, 200, "path '/' is served")
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('http transport: parse errors and unknown methods are JSON-RPC errors', async () => {
  const token = generateBridgeToken()
  const server = createHttpServer({ core: createMcpCore(stubEffects()), token })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const call = (body) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
  try {
    const parseError = await call('not json')
    assert.equal(parseError.status, 400)
    assert.equal(JSON.parse(parseError.body).error.code, -32700)
    const unknown = await call(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'resources/list' }))
    assert.equal(JSON.parse(unknown.body).error.code, -32601)
    const badTool = await call(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'drop_database' } }))
    assert.equal(JSON.parse(badTool.body).error.code, -32602)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

/* ------------------------------------------------------------------ */
/* 2. noCapture / viaAuth / private stripping                          */
/* ------------------------------------------------------------------ */

test('stripReason flags every exclusion class, and only those', () => {
  assert.equal(stripReason(baseNode({ noCapture: true })), 'noCapture')
  assert.equal(stripReason(baseNode({ viaAuth: true })), 'viaAuth')
  assert.equal(stripReason(baseNode({ private: true })), 'private')
  assert.equal(stripReason(baseNode()), null)
  assert.equal(stripReason(null), 'shape')
})

test('get_active_tab: an excluded active tab is indistinguishable from none', async () => {
  for (const patch of [{ private: true }, { noCapture: true }, { viaAuth: true }]) {
    const core = createMcpCore(stubEffects(stubSnapshot({ activeUuid: uuid(7) })))
    const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_active_tab', arguments: {} } }
    const response = await core.handleRequest(request)
    const payload = JSON.parse(response.result.content[0].text)
    assert.equal(payload.ok, true)
    assert.equal(payload.node, null, `excluded class ${JSON.stringify(patch)} must not leak the active tab`)
  }
  // no active tab at all → the same shape
  const core = createMcpCore(stubEffects(stubSnapshot({ activeUuid: null })))
  const response = await core.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_active_tab', arguments: {} } })
  assert.deepEqual(JSON.parse(response.result.content[0].text), { ok: true, node: null })
})

test('get_active_tab: allowlisted metadata + excerpt + notes for the url_hash, never thumbnails', async () => {
  const core = createMcpCore(stubEffects())
  const response = await core.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_active_tab', arguments: {} } })
  const { node } = JSON.parse(response.result.content[0].text)
  assert.equal(node.uuid, uuid(1))
  assert.equal(node.urlHash, urlHashOf('https://are.na/board'))
  assert.equal(node.ramState, 'live')
  assert.equal(node.domain, 'are.na')
  assert.equal(node.notes.length, 1)
  assert.equal(node.notes[0].text, 'palette reference')
  for (const forbidden of ['thumb', 'mediaClip', 'provenance', 'partition', 'private', 'viaAuth', 'noCapture']) {
    assert.equal(Object.hasOwn(node, forbidden), false, `${forbidden} must never cross MCP`)
  }
})

test('get_neighbourhood: excluded nodes and their whole subtree vanish; edges are cut', async () => {
  const core = createMcpCore(stubEffects())
  const response = await core.handleRequest({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'get_neighbourhood', arguments: { uuid: uuid(1), hops: 2 } },
  })
  const payload = JSON.parse(response.result.content[0].text)
  assert.equal(payload.ok, true)
  const ids = payload.nodes.map((node) => node.uuid)
  assert.deepEqual(ids.sort(), [uuid(1), uuid(2), uuid(3)].sort())
  for (const excluded of [uuid(4), uuid(5), uuid(6), uuid(7)]) {
    assert.equal(ids.includes(excluded), false, `excluded node ${excluded} must not appear`)
  }
  for (const edge of payload.edges) {
    assert.notEqual(edge.target, uuid(4), 'edges into an excluded node must be cut')
    assert.notEqual(edge.source, uuid(4))
  }
  const hibernated = payload.nodes.find((node) => node.uuid === uuid(3))
  assert.equal(hibernated.ramState, 'hibernated')
  assert.match(hibernated.excerpt, /grotesque/)
  // the parent edge of the kept child survives
  const child = payload.nodes.find((node) => node.uuid === uuid(2))
  assert.equal(child.parentUuid, uuid(1))
})

test('get_neighbourhood: unknown and excluded centres are the same error', async () => {
  const core = createMcpCore(stubEffects())
  for (const uuidValue of [uuid(4), uuid(6), uuid(7), uuid(999)]) {
    const response = await core.handleRequest({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_neighbourhood', arguments: { uuid: uuidValue } },
    })
    const payload = JSON.parse(response.result.content[0].text)
    assert.deepEqual(payload, { ok: false, error: 'unknown-node' }, `${uuidValue} must not be distinguishable`)
  }
})

test('search_spatial_graph: excluded nodes are unfindable even by exact title', () => {
  const snapshot = stubSnapshot()
  for (const needle of ['Statement', 'Inbox', 'OAuth']) {
    const result = searchGraph(snapshot, needle, 48)
    assert.equal(result.nodes.length, 0, `"${needle}" must never match an excluded node`)
  }
  const hits = searchGraph(snapshot, 'are.na', 48)
  assert.deepEqual(hits.nodes.map((node) => node.uuid).sort(), [uuid(1), uuid(2)].sort())
})

test('search_spatial_graph: notes and regions match, and are sanitized', async () => {
  const core = createMcpCore(stubEffects())
  const response = await core.handleRequest({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'search_spatial_graph', arguments: { query: 'palette' } },
  })
  const payload = JSON.parse(response.result.content[0].text)
  assert.equal(payload.ok, true)
  assert.equal(payload.notes.length, 1)
  assert.equal(payload.notes[0].urlHash, urlHashOf('https://are.na/board'))
  const regions = await core.handleRequest({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'search_spatial_graph', arguments: { query: 'type research' } },
  })
  const regionPayload = JSON.parse(regions.result.content[0].text)
  assert.deepEqual(regionPayload.regions, [{ id: 'region-1', name: 'Type research', color: '#88aaff' }])
})

test('sanitizeNodeRecord: excerpts are capped and private input is refused', () => {
  const longExcerpt = 'x'.repeat(5000)
  const node = baseNode({ uuid: uuid(1), url: 'https://a.test/x' })
  const publicShape = sanitizeNodeRecord(node, { liveUuids: new Set(), excerpts: new Map([[uuid(1), longExcerpt]]) })
  assert.equal(publicShape.excerpt.length, 2048)
  assert.equal(sanitizeNodeRecord(baseNode({ private: true }), {}), null)
  assert.equal(sanitizeNodeRecord(baseNode({ edges: [uuid(7)] }), { visibleUuids: new Set() }).childCount, 0)
})

/* ------------------------------------------------------------------ */
/* 3. url_hash dedupe for branch_hibernated_nodes                      */
/* ------------------------------------------------------------------ */

test('url_hash: mirror urls collapse onto one canonical hash', () => {
  const a = urlHashOf('https://www.example.com/path/?utm_source=x&utm_medium=y')
  const b = urlHashOf('https://example.com/path')
  assert.equal(a, b, 'utm stripping + www stripping + trailing slash must collapse')
  // a real query param is identity, not junk — it must NOT collapse
  assert.notEqual(urlHashOf('https://example.com/path/?id=9'), urlHashOf('https://example.com/path'))
  assert.equal(a, urlHashOf('http://example.com/path'), 'protocol never takes part in the hash')
})

test('planBranch: skips url_hashes already in the graph and within the call', () => {
  const snapshot = stubSnapshot()
  const planned = planBranch(snapshot, uuid(1), [
    { url: 'https://fresh.example/one', title: 'One' },
    { url: 'https://fresh.example/two' },
    { url: 'https://fresh.example/one', title: 'One again' }, // duplicate within the call
    { url: 'https://are.na/board' },                          // already a node in the graph
    { url: 'https://www.are.na/board/?utm_source=mcp' },      // canonical duplicate of the same node
    'not a url',
  ])
  assert.equal(planned.ok, true)
  assert.equal(planned.plan.length, 2)
  assert.deepEqual(planned.plan.map((child) => child.url), ['https://fresh.example/one', 'https://fresh.example/two'])
  for (const child of planned.plan) {
    assert.equal(child.parentUuid, uuid(1), 'plan items carry the parent edge')
    assert.equal(child.nodeType, null, 'default birth state is a hibernated tab, not a ghost echo')
  }
  const reasons = planned.skipped.map((entry) => entry.reason)
  assert.deepEqual(reasons, ['duplicate-url-hash', 'duplicate-url-hash', 'duplicate-url-hash', 'invalid-url'])
  // the canonical duplicate reports the hash it collided with
  assert.equal(planned.skipped[2].urlHash, urlHashOf('https://are.na/board'))
})

test('planBranch: ghost-echo birth state, parent guards, target caps', () => {
  const snapshot = stubSnapshot()
  const echo = planBranch(snapshot, uuid(2), [{ url: 'https://echo.example/a' }], { born: 'ghost-echo' })
  assert.equal(echo.plan[0].nodeType, 'ghost-echo')

  assert.equal(planBranch(snapshot, uuid(4), [{ url: 'https://x.test/a' }]).ok, false, 'excluded parent → unknown-node')
  assert.equal(planBranch(snapshot, uuid(4), [{ url: 'https://x.test/a' }]).reason, 'unknown-node')
  assert.equal(planBranch(snapshot, 'not-a-uuid', [{ url: 'https://x.test/a' }]).reason, 'invalid-parent')
  assert.equal(planBranch(snapshot, uuid(1), []).reason, 'targets')
  assert.equal(planBranch(snapshot, uuid(1), Array.from({ length: 17 }, (_, i) => ({ url: `https://x.test/${i}` }))).reason, 'too-many-targets')
  assert.equal(planBranch(snapshot, uuid(1), [{ url: 'file:///etc/passwd' }]).skipped[0].reason, 'invalid-url')
})

test('branch_hibernated_nodes: only deduped children reach the main-process command path', async () => {
  const captured = {}
  const core = createMcpCore(stubEffects(stubSnapshot(), captured))
  const response = await core.handleRequest({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: {
      name: 'branch_hibernated_nodes',
      arguments: {
        parentUuid: uuid(1),
        targets: [
          { url: 'https://fresh.example/one', title: 'One' },
          { url: 'https://fresh.example/one' },
          { url: 'https://are.na/board' },
        ],
      },
    },
  })
  const payload = JSON.parse(response.result.content[0].text)
  assert.equal(payload.ok, true)
  assert.equal(captured.branchCalls.length, 1, 'exactly one apply')
  assert.equal(captured.branchCalls[0].parentUuid, uuid(1))
  assert.equal(captured.branchCalls[0].children.length, 1, 'the duplicate and the existing hash never spawn')
  assert.equal(payload.created.length, 1)
  assert.equal(payload.created[0].ramState, 'hibernated', 'agent children are born hibernated')
  assert.equal(payload.created[0].parentUuid, uuid(1))
  assert.deepEqual(payload.skipped.map((entry) => entry.reason), ['duplicate-url-hash', 'duplicate-url-hash'])
  // the warm pool was never touched: no tab/open/ensure call exists on the effect surface
  assert.deepEqual(Object.keys(captured), ['branchCalls'], 'no live-pool effect may be invoked')
})

test('branch_hibernated_nodes: excluded parent refuses without calling any effect', async () => {
  const captured = {}
  const core = createMcpCore(stubEffects(stubSnapshot(), captured))
  const response = await core.handleRequest({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'branch_hibernated_nodes', arguments: { parentUuid: uuid(7), targets: [{ url: 'https://x.test/a' }] } },
  })
  const payload = JSON.parse(response.result.content[0].text)
  assert.deepEqual(payload, { ok: false, error: 'unknown-node' })
  assert.equal(captured.branchCalls, undefined, 'no effect may run for an excluded parent')
})

test('write tools route through the shell command path with sanitized args', async () => {
  const captured = {}
  const core = createMcpCore(stubEffects(stubSnapshot(), captured))
  const note = await core.handleRequest({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'add_sticky_note', arguments: { url: 'https://www.example.com/post/1?utm_source=mcp', text: 'check the grid' } },
  })
  const notePayload = JSON.parse(note.result.content[0].text)
  assert.equal(notePayload.ok, true)
  assert.equal(notePayload.urlHash, urlHashOf('https://example.com/post/1'))
  assert.deepEqual(captured.shellCommands[0], {
    action: 'addStickyNote',
    args: { urlHash: urlHashOf('https://example.com/post/1'), text: 'check the grid' },
  }, 'the shell receives the canonical url_hash — the same key the UI notes attach to')

  const tidy = await core.handleRequest({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'tidy_region_moodboard', arguments: { regionId: 'region-1' } },
  })
  assert.equal(JSON.parse(tidy.result.content[0].text).ok, true)
  assert.deepEqual(captured.shellCommands[1], { action: 'tidyToMoodboard', args: { regionId: 'region-1' } })

  const unknownRegion = await core.handleRequest({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'tidy_region_moodboard', arguments: { regionId: 'region-ghost' } },
  })
  assert.deepEqual(JSON.parse(unknownRegion.result.content[0].text), { ok: false, error: 'unknown-region' })
  assert.equal(captured.shellCommands.length, 2, 'unknown regions never reach the shell')

  // shell unavailable → honest failure, never a fake success
  const offline = createMcpCore({ graphSnapshot: stubEffects().graphSnapshot, branchHibernated: async () => ({ ok: true, created: [] }), shellCommand: async () => ({ ok: false, error: 'shell-unavailable' }) })
  const down = await offline.handleRequest({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'add_sticky_note', arguments: { url: 'https://x.test/a', text: 'hi' } },
  })
  assert.deepEqual(JSON.parse(down.result.content[0].text), { ok: false, error: 'shell-unavailable', urlHash: urlHashOf('https://x.test/a') })
})

test('shell state sync is capped and sanitized', () => {
  const notes = Array.from({ length: 600 }, (_, i) => ({ id: `note-${i}`, urlHash: 'u0', text: 'x'.repeat(5000), createdAt: i, updatedAt: i }))
  const normalized = normalizeShellState({ notes, regions: [{ id: 'r', name: 'n'.repeat(300), color: 'javascript:alert(1)' }] })
  assert.equal(normalized.notes.length, 512)
  assert.equal(normalized.notes[0].text.length, 4000)
  assert.equal(normalized.regions.length, 1)
  assert.equal(normalized.regions[0].name.length, 120)
  assert.equal(normalized.regions[0].color.length <= 16, true, 'hostile color payloads are truncated, never executed')
})

test('the tool surface is exactly the six addendum tools', () => {
  assert.deepEqual(TOOL_DESCRIPTORS.map((tool) => tool.name), [
    'get_active_tab',
    'get_neighbourhood',
    'search_spatial_graph',
    'branch_hibernated_nodes',
    'add_sticky_note',
    'tidy_region_moodboard',
  ])
})
