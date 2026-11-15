// node --test — end-to-end stdio wrapper check for the local MCP bridge
// (Phase 3.7). Spawns `node mcp-server.js --stdio` as a real child process
// and hands it the per-launch token the ONLY way the hardening notes allow
// the browser to: through the wrapper's ENV. Proves the full chain
//   agent stdin → wrapper → bearer-authed 127.0.0.1 HTTP → core
// including that the wrapper without any endpoint env refuses to run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { createMcpCore, createHttpServer, generateBridgeToken, urlHashOf } = require('../src/main/mcp-server.js')

const WRAPPER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main', 'mcp-server.js')

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function stubCore() {
  return createMcpCore({
    graphSnapshot: () => ({
      nodes: [{
        uuid: uuid(1), url: 'https://are.na/board', title: 'Are.na board', x: 10, y: 20,
        parentUuid: null, edges: [], createdAt: 1, lastActiveAt: 2,
      }],
      liveUuids: new Set([uuid(1)]),
      activeUuid: uuid(1),
      excerpts: new Map(),
      notes: [],
      regions: [],
    }),
    branchHibernated: async () => ({ ok: true, created: [] }),
    shellCommand: async () => ({ ok: false, error: 'shell-unavailable' }),
  })
}

/** Run the wrapper against a live bridge; returns its stdout lines. */
async function runWrapper({ port, token, requests }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRAPPER_PATH, '--stdio'], {
      env: {
        ...process.env,
        SPATIAL_MCP_PORT: String(port),
        SPATIAL_MCP_TOKEN: token,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, lines: out.split('\n').filter(Boolean), err }))
    child.stdin.write(requests.map((request) => `${JSON.stringify(request)}\n`).join(''))
    child.stdin.end()
    setTimeout(() => { child.kill(); reject(new Error(`wrapper timed out; stderr: ${err}`)) }, 10_000).unref()
  })
}

test('stdio wrapper: env handoff authenticates the full chain initialize → tools/call', async () => {
  const token = generateBridgeToken()
  const server = createHttpServer({ core: stubCore(), token })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const { code, lines } = await runWrapper({
      port,
      token,
      requests: [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_active_tab', arguments: {} } },
      ],
    })
    assert.equal(code, 0, `wrapper exited cleanly (stderr: ${lines.length ? '' : 'see above'})`)
    assert.equal(lines.length, 2, 'the notification produces no response line')
    const hello = JSON.parse(lines[0])
    assert.equal(hello.result.serverInfo.name, 'spatial-browser')
    assert.equal(hello.result.protocolVersion, '2025-06-18')
    const active = JSON.parse(lines[1])
    const payload = JSON.parse(active.result.content[0].text)
    assert.equal(payload.ok, true)
    assert.equal(payload.node.uuid, uuid(1))
    assert.equal(payload.node.urlHash, urlHashOf('https://are.na/board'))
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('stdio wrapper: with no reachable bridge it answers an honest JSON-RPC error', async () => {
  // port 1 is unbindable/unreachable for a client on this host
  const { lines } = await runWrapper({
    port: 1,
    token: generateBridgeToken(),
    requests: [{ jsonrpc: '2.0', id: 7, method: 'tools/list' }],
  })
  const response = JSON.parse(lines[0])
  assert.equal(response.id, 7)
  assert.equal(response.error.code, -32603)
})

test('stdio wrapper: wrong token is rejected by the bridge, not the wrapper', async () => {
  const server = createHttpServer({ core: stubCore(), token: generateBridgeToken() })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const { lines } = await runWrapper({
      port,
      token: generateBridgeToken(), // a different launch's token
      requests: [{ jsonrpc: '2.0', id: 8, method: 'tools/list' }],
    })
    const response = JSON.parse(lines[0])
    // The bridge's plain 401 body is forwarded verbatim — no JSON-RPC
    // result, no hint about the token itself.
    assert.deepEqual(response, { error: 'unauthorized' })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
