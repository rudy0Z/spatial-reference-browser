// node --test suite for the spatial IPC seam (fake registrars, no Electron).
// Proves the channel contract: every spatial:* channel registers through the
// injected trust-gated registrars, payloads are validated before any effect
// runs, and main → renderer events stay out of this module entirely.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createGraphIpc, GRAPH_SERVICES } = require('../src/main/spatial/graph-ipc.js')

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/** Two-way fake of main.js's chromeHandle/chromeOn registrars. The real
 * registrars call handler(event, ...args) — the fake binds the event stub so
 * tests can call handlers with just the renderer payload, exactly like the
 * contract's caller side. */
function fakeRegistrars() {
  const invoked = new Map()
  const sent = new Map()
  return {
    invoked,
    sent,
    chromeHandle: (channel, handler) => invoked.set(channel, async (payload) => handler({}, payload)),
    chromeOn: (channel, handler) => sent.set(channel, (payload) => handler({}, payload)),
  };
}

test('register wires exactly the ten spatial channels to the right registrar kind', () => {
  const { invoked, sent } = fakeRegistrars()
  const ipc = createGraphIpc({ ...{ chromeHandle: (c, h) => invoked.set(c, h), chromeOn: (c, h) => sent.set(c, h) }, handlers: {} })
  ipc.register()
  for (const channel of [
    'spatial:graph:load',
    'spatial:graph:mutate',
    'spatial:node:open',
    'spatial:node:close',
    'spatial:node:navigate',
    'spatial:mode:set',
  ]) {
    assert.ok(invoked.has(channel), `${channel} must be an invoke (chromeHandle)`)
    assert.equal(sent.has(channel), false, `${channel} must not be fire-and-forget`)
  }
  for (const channel of [
    'spatial:chrome:layout',
    'spatial:zorder:engage',
    'spatial:zorder:release',
    'spatial:thumb:store',
  ]) {
    assert.ok(sent.has(channel), `${channel} must be fire-and-forget (chromeOn)`)
    assert.equal(invoked.has(channel), false, `${channel} must not be an invoke`)
  }
  assert.equal(GRAPH_SERVICES.length, 10)
})

test('graph:load returns the model payload; mutate applies validated ops', async () => {
  const reg = fakeRegistrars()
  const calls = []
  const ipc = createGraphIpc({
    ...reg,
    handlers: {
      load: () => { calls.push('load'); return { ok: true, graph: { version: 1, nodes: [] } } },
      mutate: (ops) => { calls.push(['mutate', ops]); return { ok: true } },
    },
  })
  ipc.register()
  const loadResult = await reg.invoked.get('spatial:graph:load')()
  assert.equal(loadResult.ok, true)
  assert.deepEqual(calls[0], 'load')

  const ops = [{ type: 'add', node: { uuid: uuid(1), url: 'https://example.test/' } }]
  const mutateResult = await reg.invoked.get('spatial:graph:mutate')(ops)
  assert.equal(mutateResult.ok, true)
  assert.deepEqual(calls[1], ['mutate', ops])
})

test('mutate rejects invalid batches before the effect runs', async () => {
  const reg = fakeRegistrars()
  let mutateCalls = 0
  const ipc = createGraphIpc({ ...reg, handlers: { mutate: () => { mutateCalls += 1; return { ok: true } } } })
  ipc.register()
  const mutate = reg.invoked.get('spatial:graph:mutate')

  assert.deepEqual(await mutate('not-an-array'), { ok: false, error: 'ops' })
  assert.deepEqual(await mutate([]), { ok: false, error: 'ops' })
  assert.deepEqual(await mutate([{ type: 'explode' }]), { ok: false, error: 'op' })
  assert.deepEqual(await mutate(Array.from({ length: 257 }, () => ({ type: 'activate', uuid: uuid(1), at: 1 }))),
    { ok: false, error: 'ops' })
  assert.equal(mutateCalls, 0, 'no effect may run for rejected batches')
  await mutate([{ type: 'activate', uuid: uuid(1), at: 1 }])
  assert.equal(mutateCalls, 1, 'a valid batch reaches the effect')
})

test('mode:set accepts only reading|canvas; node channels validate uuids', async () => {
  const reg = fakeRegistrars()
  const seen = []
  const ipc = createGraphIpc({
    ...reg,
    handlers: {
      setMode: (mode) => { seen.push(['mode', mode]); return { ok: true } },
      openNode: (uuidValue) => { seen.push(['open', uuidValue]); return { ok: true } },
      closeNode: (uuidValue) => { seen.push(['close', uuidValue]); return { ok: true } },
    },
  })
  ipc.register()
  assert.deepEqual(await reg.invoked.get('spatial:mode:set')({ mode: 'canvas' }), { ok: true })
  assert.deepEqual(await reg.invoked.get('spatial:mode:set')({ mode: 'reading' }), { ok: true })
  assert.deepEqual(await reg.invoked.get('spatial:mode:set')({ mode: 'pwn' }), { ok: false, error: 'mode' })
  assert.deepEqual(await reg.invoked.get('spatial:mode:set')(null), { ok: false, error: 'mode' })
  assert.deepEqual(await reg.invoked.get('spatial:node:open')({ uuid: uuid(5) }), { ok: true })
  assert.deepEqual(await reg.invoked.get('spatial:node:open')({ uuid: '; DROP TABLE' }), { ok: false, error: 'uuid' })
  assert.deepEqual(await reg.invoked.get('spatial:node:close')({ uuid: uuid(6) }), { ok: true })
  assert.deepEqual(seen, [['mode', 'canvas'], ['mode', 'reading'], ['open', uuid(5)], ['close', uuid(6)]])
})

test('thumb:store accepts only webp data URLs within the size budget', () => {
  const reg = fakeRegistrars()
  const thumbs = []
  const ipc = createGraphIpc({
    ...reg,
    handlers: { storeThumb: ({ uuid: uuidValue, dataUrl }) => { thumbs.push([uuidValue, dataUrl]) } },
  })
  ipc.register()
  const store = reg.sent.get('spatial:thumb:store')
  store({ uuid: uuid(1), dataUrl: 'data:image/webp,AAAA' })
  assert.deepEqual(thumbs, [[uuid(1), 'data:image/webp,AAAA']])
  // Chromium's canvas encoder adds a quality parameter — accepted.
  store({ uuid: uuid(2), dataUrl: 'data:image/webp;quality=0.8,BBBB' })
  assert.deepEqual(thumbs[1], [uuid(2), 'data:image/webp;quality=0.8,BBBB'])
  // PNG masquerading as a thumb is refused (the renderer's transcode is the
  // only sanctioned source of webp thumbnails).
  thumbs.length = 0
  store({ uuid: uuid(1), dataUrl: 'data:image/png,AAAA' })
  store({ uuid: uuid(1), dataUrl: `data:image/webp,${'A'.repeat(600 * 1024)}` })
  store({ uuid: 'garbage', dataUrl: 'data:image/webp,AAAA' })
  assert.deepEqual(thumbs, [])
})

test('chrome:layout is sanitized before the effect sees it', () => {
  const reg = fakeRegistrars()
  const layouts = []
  const ipc = createGraphIpc({
    ...reg,
    handlers: { setChromeLayout: (layout) => { layouts.push(layout) } },
  })
  ipc.register()
  reg.sent.get('spatial:chrome:layout')({ topBarHeight: 48, railWidth: 224, mode: 'reading' })
  reg.sent.get('spatial:chrome:layout')({ topBarHeight: 9999, mode: 'weird' })
  assert.deepEqual(layouts[0], { topBarHeight: 48, railWidth: 224, mode: 'reading' })
  assert.deepEqual(layouts[1], { topBarHeight: 120, railWidth: 224, mode: 'reading' })
})

test('missing registrars are a programming error, not a silent no-op', () => {
  assert.throws(() => createGraphIpc({ handlers: {} }), TypeError)
  assert.throws(() => createGraphIpc({ chromeHandle: () => {}, handlers: {} }), TypeError)
})
