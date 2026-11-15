// node --test suite for the §B.9 Zero-Extension "Live Mods" engine:
//   - domain-pattern matching (mod records are domain-keyed),
//   - compiled-CSS shape (the exact §B.9 injection string),
//   - resilient zap-selector generation (data-testid / id preferred,
//     structural fallback),
//   - plus the wiring contract: injection on dom-ready survives reload,
//     toggle-off removes the exact stylesheets, and a zapped descriptor
//     lands in the domain's zapSelectors[].
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const model = require('../src/main/spatial/live-mods-model.js')
const { createLiveMods } = require('../src/main/live-mods.js')

/* ------------------------------------------------------------------ */
/* 1. Domain-pattern matching                                           */
/* ------------------------------------------------------------------ */

test('apex patterns match the domain and its subdomains', () => {
  assert.equal(model.domainPatternMatches('example.com', 'https://example.com/a'), true)
  assert.equal(model.domainPatternMatches('example.com', 'https://www.example.com/x?y=1'), true)
  assert.equal(model.domainPatternMatches('example.com', 'https://deep.nested.example.com/'), true)
})

test('unrelated hosts never match, even by suffix', () => {
  assert.equal(model.domainPatternMatches('example.com', 'https://badexample.com/'), false)
  assert.equal(model.domainPatternMatches('example.com', 'https://example.org/'), false)
  assert.equal(model.domainPatternMatches('example.com', 'https://example.com.evil.test/'), false)
})

test('explicit *. patterns match subdomains only, never the apex', () => {
  assert.equal(model.domainPatternMatches('*.example.com', 'https://cdn.example.com/'), true)
  assert.equal(model.domainPatternMatches('*.example.com', 'https://example.com/'), false)
  assert.equal(model.domainPatternMatches('*.example.com', 'https://a.b.example.com/'), true)
})

test('patterns and urls normalize: case, scheme, path, port', () => {
  assert.equal(model.domainPatternMatches('EXAMPLE.com/path:8080', 'https://example.com:4443/anything'), true)
  assert.equal(model.normalizeDomainPattern('  HTTPS://News.YCombinator.COM/item '), 'news.ycombinator.com')
})

test('invalid patterns are refused — no match, no crash', () => {
  for (const bad of ['', '   ', '.com', 'not a domain', 'example..com', 'a b c', null, undefined, 42]) {
    assert.equal(model.normalizeDomainPattern(bad), null, String(bad))
    assert.equal(model.domainPatternMatches(bad, 'https://example.com/'), false, String(bad))
  }
  // Trailing dots are stripped; a bare 'localhost' stays scopeable (dev servers).
  assert.equal(model.normalizeDomainPattern('localhost.'), 'localhost')
  assert.equal(model.normalizeDomainPattern('LOCALHOST'), 'localhost')
  assert.equal(model.domainPatternMatches('localhost', 'http://localhost:3000/dev'), true)
})

test('non-web schemes have no hostname, so nothing matches', () => {
  for (const url of ['blanc-chrome://spatial/', 'blanc://newtab', 'about:blank', 'file:///C:/x.html', 'not a url']) {
    assert.equal(model.hostnameOf(url), null, url)
    assert.equal(model.domainPatternMatches('example.com', url), false, url)
  }
  assert.equal(model.hostnameOf('https://Example.COM:8080/p'), 'example.com')
})

/* ------------------------------------------------------------------ */
/* 2. Compiled-CSS shape                                                */
/* ------------------------------------------------------------------ */

test('compiled CSS is exactly zapSelectors.join(", ") + hide rule + css', () => {
  const mod = {
    id: 'zap:example.com',
    domainPattern: 'example.com',
    name: 'Element zaps',
    enabled: true,
    css: 'body { color: hotpink; }',
    zapSelectors: ['[data-testid="close"]', '#cookie-wall', 'div.banner:nth-of-type(2)'],
  }
  assert.equal(
    model.compileModCss(mod),
    '[data-testid="close"], #cookie-wall, div.banner:nth-of-type(2) { display: none !important; }\n'
      + 'body { color: hotpink; }',
  )
})

test('selectors-only and css-only mods compile to their single half', () => {
  assert.equal(
    model.compileModCss({ id: 'zap:x.com', domainPattern: 'x.com', enabled: true, css: '', zapSelectors: ['a.banner'] }),
    'a.banner { display: none !important; }',
  )
  assert.equal(
    model.compileModCss({ id: 'css:x.com', domainPattern: 'x.com', enabled: true, css: 'p { margin: 0; }', zapSelectors: [] }),
    'p { margin: 0; }',
  )
})

test('disabled or empty mods compile to nothing — the §B.0 zero-cost law', () => {
  assert.equal(model.compileModCss({ id: 'm', domainPattern: 'x.com', enabled: false, css: 'p{}', zapSelectors: ['a'] }), '')
  assert.equal(model.compileModCss({ id: 'm', domainPattern: 'x.com', enabled: true, css: '', zapSelectors: [] }), '')
  assert.equal(model.compileEnabledCss([
    { id: 'a', domainPattern: 'x.com', enabled: true, css: 'p{}', zapSelectors: [] },
    { id: 'b', domainPattern: 'x.com', enabled: false, css: 'q{}', zapSelectors: [] },
    { id: 'c', domainPattern: 'x.com', enabled: true, css: 'i{}', zapSelectors: ['b'] },
  ]), 'p{}\nb { display: none !important; }\ni{}')
})

test('hostile selectors are refused before they can reach a stylesheet', () => {
  for (const hostile of ['a { }', 'a } body {', 'x; } y {', '@import url(x)', 'p > script{}{}', '', '   ']) {
    assert.equal(model.sanitizeSelector(hostile), null, hostile)
  }
  // escaped attribute values (backslash, quotes) and combinators stay legal
  assert.equal(model.sanitizeSelector('[id="a\\"b"]'), '[id="a\\"b"]')
  assert.equal(model.sanitizeSelector('div.wall > button:nth-of-type(2)'), 'div.wall > button:nth-of-type(2)')
  assert.equal(model.buildZapRule(['ok-selector', 'a { }']), 'ok-selector { display: none !important; }')
})

test('normalizeModRecord clamps, dedupes and drops broken records', () => {
  const kept = model.normalizeModRecord({
    id: 'zap:x.com', domainPattern: 'X.com', enabled: true, name: '  Zaps  ',
    css: 'p{}\np{}\n', zapSelectors: ['a', 'a', 'b {', 5, null],
  })
  assert.deepEqual(kept, {
    id: 'zap:x.com', domainPattern: 'x.com', name: 'Zaps', enabled: true,
    css: 'p{}\np{}\n', zapSelectors: ['a'],
  })
  for (const broken of [null, {}, { id: 'bad id!' }, { id: 'ok', domainPattern: '???' }]) {
    assert.equal(model.normalizeModRecord(broken), null)
  }
  const many = model.normalizeModRecord({
    id: 'zap:x.com', domainPattern: 'x.com', enabled: true,
    zapSelectors: Array.from({ length: model.MAX_ZAP_SELECTORS + 10 }, (_, i) => `s${i}`),
  })
  assert.equal(many.zapSelectors.length, model.MAX_ZAP_SELECTORS)
})

test('the armed-zapper script pins the exact §B.9 outline and gesture', () => {
  const arm = model.zapArmScript()
  assert.equal(model.ZAP_OUTLINE, '1px solid rgba(255,255,255,0.35)')
  assert.ok(arm.includes('1px solid rgba(255,255,255,0.35)'))
  assert.ok(arm.includes('event.altKey === true && event.shiftKey === true')) // armed Alt+Shift+Click only
  assert.ok(arm.includes("addEventListener('mouseover', onOver, true)"))
  assert.ok(arm.includes('stopImmediatePropagation'))
  assert.ok(model.zapDisarmScript().includes('__spatialZapTeardown'))
  assert.ok(model.zapAwaitScript(5000).includes('new Promise'))
  assert.ok(model.zapAwaitScript(5000).includes('5000'))
})

/* ------------------------------------------------------------------ */
/* 3. Resilient zap-selector generation                                 */
/* ------------------------------------------------------------------ */

const seg = (over) => ({ tag: 'div', id: null, testId: null, dataTest: null, dataQa: null, classes: [], nth: 1, ...over })

test('data-testid on the clicked element wins — and only on the clicked element', () => {
  // An ancestor testid must NOT be returned alone: it would hide a container.
  const descriptor = {
    chain: [
      seg({ tag: 'button' }),
      seg({ tag: 'div', testId: 'ad-slot' }),
    ],
  }
  assert.notEqual(model.buildResilientSelector(descriptor), '[data-testid="ad-slot"]')
  assert.equal(model.buildResilientSelector({
    chain: [seg({ tag: 'button', testId: 'close-banner' })],
  }), '[data-testid="close-banner"]')
  assert.equal(model.buildResilientSelector({
    chain: [seg({ tag: 'span', dataTest: 'newsletter' })],
  }), '[data-test="newsletter"]')
  assert.equal(model.buildResilientSelector({
    chain: [seg({ tag: 'i', dataQa: 'promo-x' })],
  }), '[data-qa="promo-x"]')
})

test('id fallback: clean ident → #id; generated id → attribute form', () => {
  assert.equal(model.buildResilientSelector({ chain: [seg({ tag: 'aside', id: 'cookie-wall' })] }), '#cookie-wall')
  assert.equal(
    model.buildResilientSelector({ chain: [seg({ tag: 'aside', id: '1weird id' })] }),
    '[id="1weird id"]',
  )
  assert.equal(
    model.buildResilientSelector({ chain: [seg({ tag: 'x', id: 'a"b' })] }),
    '[id="a\\"b"]',
  )
})

test('structural fallback: anchored at the nearest stable ancestor', () => {
  const descriptor = {
    chain: [
      seg({ tag: 'button', classes: ['banner-close'], nth: 2 }),
      seg({ tag: 'div', classes: ['cookie-wall'], nth: 2 }),
      seg({ tag: 'main', id: 'content', nth: 1 }),
      seg({ tag: 'body', nth: 1 }),
    ],
  }
  assert.equal(
    model.buildResilientSelector(descriptor),
    '#content div.cookie-wall:nth-of-type(2) > button.banner-close:nth-of-type(2)',
  )
})

test('framework-generated classes are skipped, nth-of-type carries the path', () => {
  const descriptor = {
    chain: [
      seg({ tag: 'div', classes: ['css-1q2w3e4r', 'sc-jSMfEi', 'banner'], nth: 3 }),
      seg({ tag: 'body', nth: 1 }),
    ],
  }
  assert.equal(model.buildResilientSelector(descriptor), 'body:nth-of-type(1) > div.banner:nth-of-type(3)')
  // every class generated → pure structural segment
  assert.equal(
    model.buildResilientSelector({
      chain: [seg({ tag: 'div', classes: ['css-1q2w3e4r'], nth: 3 }), seg({ tag: 'body', nth: 1 })],
    }),
    'body:nth-of-type(1) > div:nth-of-type(3)',
  )
})

test('no anchor anywhere → full path from the outermost captured ancestor', () => {
  const descriptor = {
    chain: [
      seg({ tag: 'button', nth: 1 }),
      seg({ tag: 'div', classes: ['modal'], nth: 4 }),
      seg({ tag: 'body', nth: 1 }),
    ],
  }
  assert.equal(model.buildResilientSelector(descriptor), 'body:nth-of-type(1) > div.modal:nth-of-type(4) > button:nth-of-type(1)')
})

test('garbage descriptors return null, never throw', () => {
  for (const bad of [null, undefined, 42, 'x', {}, { chain: [] }, { chain: [null, 7] }, { chain: [seg({ tag: '<<' })] }]) {
    assert.equal(model.buildResilientSelector(bad), null)
  }
})

test('attribute values with quotes or backslashes are escaped, not broken', () => {
  const selector = model.buildResilientSelector({ chain: [seg({ tag: 'b', testId: 'say "hi" \\ ok' })] })
  assert.equal(selector, '[data-testid="say \\"hi\\" \\\\ ok"]')
  assert.equal(model.sanitizeSelector(selector), selector)
})

/* ------------------------------------------------------------------ */
/* 4. Wiring contract — store, injection, reload survival, zap flow      */
/* ------------------------------------------------------------------ */

/** Minimal WebContentsView stand-in: listeners, insertCSS bookkeeping. */
function fakeWc(initialUrl) {
  const listeners = new Map()
  const inserted = new Map()
  let nextKey = 1
  let descriptorSent = false
  let url = initialUrl
  return {
    getURL: () => url,
    setURL: (next) => { url = next },
    isDestroyed: () => false,
    on: (event, callback) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(callback)
    },
    emit(event) {
      for (const callback of listeners.get(event) ?? []) callback()
    },
    insertCSS: async (css) => {
      const key = `key-${nextKey++}`
      inserted.set(key, css)
      return key
    },
    removeInsertedCSS: async (key) => { inserted.delete(key) },
    insertedCss: () => [...inserted.values()],
    insertedCount: () => inserted.size,
    // The zapper scripts are recognized by shape; the waiter resolves ONE
    // canned descriptor (one user click), then null — like a real page.
    executeJavaScript: async (script) => {
      if (script.includes('return new Promise')) {
        if (descriptorSent) return null
        descriptorSent = true
        return { chain: [seg({ tag: 'aside', id: 'cookie-wall', nth: 1 }), seg({ tag: 'body', nth: 1 })] }
      }
      return true
    },
  }
}

function fakeStore() {
  return {
    data: { version: 1, nodes: [], mods: [] },
    updateCount: 0,
    update(fn) { fn(this.data); this.updateCount++ },
  }
}

function fakeRegistrars() {
  const handlers = new Map()
  return {
    handlers,
    chromeHandle: (channel, handler) => handlers.set(channel, handler),
    chromeOn: (channel, handler) => handlers.set(channel, handler),
    invoke: (channel, payload) => {
      const handler = handlers.get(channel)
      assert.ok(handler, `channel ${channel} registered`)
      return Promise.resolve(handler({ sender: 'test' }, payload))
    },
  }
}

function setup() {
  const store = fakeStore()
  const reg = fakeRegistrars()
  const attached = []
  let activeView = null
  const shells = []
  const engine = createLiveMods({
    chromeHandle: reg.chromeHandle,
    chromeOn: reg.chromeOn,
    store,
    getActiveView: () => activeView,
    iterViews: () => attached,
    notifyShell: (channel, payload) => shells.push({ channel, payload }),
  })
  engine.register()
  return { store, reg, engine, attached, setActive: (view) => { activeView = view }, shells }
}

test('mods list exposes the three §B.9 presets through the trust gate', async () => {
  const { reg } = setup()
  const list = await reg.invoke('spatial:mods:list')
  assert.equal(list.ok, true)
  assert.deepEqual(list.presets.map((p) => p.id), ['matte-reader', 'desaturate-chrome', 'surface'])
  assert.deepEqual(list.presets.find((p) => p.id === 'surface').variants, ['paper', 'graphite'])
})

test('injection lands on dom-ready and survives a reload (fresh re-injection)', async () => {
  const { reg, engine } = setup()
  const wc = fakeWc('https://example.com/article')
  engine.attachView(1, wc)
  assert.equal(wc.insertedCount(), 0) // nothing scoped yet

  const saved = await reg.invoke('spatial:mods:set-css', { domain: 'example.com', css: 'body { margin: 0; }' })
  assert.equal(saved.ok, true)

  wc.emit('dom-ready')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(wc.insertedCount(), 1)
  assert.ok(wc.insertedCss()[0].includes('body { margin: 0; }'))

  // Reload: the new document must get exactly one fresh stylesheet.
  wc.emit('dom-ready')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(wc.insertedCount(), 1)

  // An SPA route into another domain removes the stylesheet (delta path).
  wc.setURL('https://other.test/page')
  wc.emit('did-navigate-in-page')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(wc.insertedCount(), 0)
})

test('toggle-off removes exactly that mod\'s stylesheets; state persists with the graph', async () => {
  const { reg, engine, store } = setup()
  const wc = fakeWc('https://example.com/')
  engine.attachView(1, wc)
  await reg.invoke('spatial:mods:apply-preset', { domain: 'example.com', presetId: 'matte-reader' })
  await reg.invoke('spatial:mods:set-css', { domain: 'example.com', css: 'p { color: rebeccapurple; }' })
  wc.emit('dom-ready')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(wc.insertedCount(), 2)

  const off = await reg.invoke('spatial:mods:set-enabled', { id: 'css:example.com', enabled: false })
  assert.equal(off.ok, true)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(wc.insertedCount(), 1) // only the preset sheet remains
  assert.ok(!wc.insertedCss().join('\n').includes('rebeccapurple'))

  const list = await reg.invoke('spatial:mods:list')
  assert.equal(list.mods.find((m) => m.id === 'css:example.com').enabled, false)
  assert.equal(store.data.mods.length, 2) // persisted beside the graph nodes
  assert.ok(store.updateCount > 0)

  const removed = await reg.invoke('spatial:mods:remove', { id: 'css:example.com' })
  assert.equal(removed.ok, true)
  const after = await reg.invoke('spatial:mods:list')
  assert.equal(after.mods.some((m) => m.id === 'css:example.com'), false)
})

test('a zapped descriptor saves a resilient selector on the domain and hides it', async () => {
  const { reg, engine, setActive, store } = setup()
  const wc = fakeWc('https://ads.example.com/watch')
  engine.attachView(1, wc)
  setActive({ tabId: 1, wc })

  const armed = await reg.invoke('spatial:zap:arm')
  assert.equal(armed.ok, true)
  await new Promise((resolve) => setTimeout(resolve, 20)) // the zap waiter resolves

  const list = await reg.invoke('spatial:mods:list')
  assert.equal(list.zapArmed, true)
  const zap = list.mods.find((m) => m.id === 'zap:ads.example.com')
  assert.ok(zap, 'domain zap record created')
  assert.deepEqual(zap.zapSelectors, ['#cookie-wall'])

  wc.emit('dom-ready') // reload: the zap survives via re-injection
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(wc.insertedCount(), 1)
  assert.ok(wc.insertedCss()[0].startsWith('#cookie-wall { display: none !important; }'))

  const disarmed = await reg.invoke('spatial:zap:disarm')
  assert.equal(disarmed.armed, false)
  // Removing the last selector removes the record too.
  await reg.invoke('spatial:mods:zap-remove', { id: 'zap:ads.example.com', selector: '#cookie-wall' })
  const after = await reg.invoke('spatial:mods:list')
  assert.equal(after.mods.some((m) => m.id === 'zap:ads.example.com'), false)
  assert.ok(store.data.mods.length === 0)
})

test('preset application compiles the preset CSS into the domain record', async () => {
  const { reg } = setup()
  await reg.invoke('spatial:mods:apply-preset', { domain: 'reader.test', presetId: 'surface', variant: 'graphite' })
  const list = await reg.invoke('spatial:mods:list')
  const mod = list.mods.find((m) => m.id === 'preset:surface:reader.test')
  assert.ok(mod)
  assert.equal(mod.enabled, true)
  assert.ok(mod.css.includes('color-scheme: dark'))
  assert.equal(mod.domainPattern, 'reader.test')
  const bad = await reg.invoke('spatial:mods:apply-preset', { domain: 'reader.test', presetId: 'nope' })
  assert.equal(bad.ok, false)
})
