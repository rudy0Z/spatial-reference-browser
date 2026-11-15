// §B.10 Studio Plugins unit tests (Phase 3.6) — the pure parts only, no
// React/Electron/store:
//   1. the registry's pure layer (app/src/lib/plugins-pure.ts, re-exported
//      by app/src/lib/plugins.ts): media drop detection, X-Ray token →
//      Markdown formatting, sRGB → OKLCH color math, cubic-bezier extraction;
//   2. the node title helper (app/src/lib/types.ts mediaClipTitle);
//   3. main's pure plugin model (browser/src/main/spatial/
//      studio-plugins-model.js): clip-request normalization, MIME
//      allowlist, WebM store validation, breakpoint policy.
// The registry's runtime half (zustand store + spatialAPI calls in
// plugins.ts) is deliberately NOT imported here — it pulls the spatial
// bridge and the whole graph store into the harness.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BREAKPOINT_PRESETS,
  detectMediaDrop,
  extractMediaUrlFromHtml,
  firstCubicBezier,
  formatColorPair,
  formatOklch,
  formatXrayMarkdown,
  hexToRgbChannels,
  mediaKindOfUrl,
  rgbToOklch,
} from '../src/lib/plugins-pure.ts'
import { mediaClipTitle } from '../src/lib/types.ts'
import mainModel from '../../browser/src/main/spatial/studio-plugins-model.js'

/* ------------------------------------------------------------------ */
/* 1 — media drop detection (Plugin B)                                 */
/* ------------------------------------------------------------------ */

const dt = (types, data) => ({ types, getData: (type) => data[type] ?? '' })

test('detectMediaDrop finds an img drag in text/html and keeps the source page', () => {
  const drop = detectMediaDrop(
    dt(['text/html', 'text/uri-list'], {
      'text/html': '<img src="https://cdn.example.com/hero.png" alt="">',
      'text/uri-list': 'https://cdn.example.com/hero.png',
    }),
    'https://example.com/gallery',
  )
  assert.deepEqual(drop, {
    kind: 'media-clip',
    mediaKind: 'image',
    src: 'https://cdn.example.com/hero.png',
    sourcePageUrl: 'https://example.com/gallery',
  })
})

test('detectMediaDrop classifies a <video> source as video', () => {
  const drop = detectMediaDrop(
    dt(['text/html'], { 'text/html': '<video controls><source src="https://x.example/clip.mp4"></video>' }),
    null,
  )
  assert.equal(drop?.kind, 'media-clip')
  assert.equal(drop?.mediaKind, 'video')
  assert.equal(drop?.src, 'https://x.example/clip.mp4')
})

test('detectMediaDrop treats an inline <svg> drag as svg markup', () => {
  const markup = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>'
  const drop = detectMediaDrop(dt(['text/html'], { 'text/html': markup }), 'https://example.com/spec')
  assert.equal(drop?.kind, 'media-clip')
  assert.equal(drop?.mediaKind, 'svg')
  assert.equal(drop?.src, '')
  assert.equal(drop?.markup, markup)
})

test('detectMediaDrop resolves media URLs from text/uri-list by extension', () => {
  const drop = detectMediaDrop(
    dt(['text/uri-list', 'text/plain'], { 'text/uri-list': 'https://site.example/a/b/movie.webm' }),
    null,
  )
  assert.equal(drop?.mediaKind, 'video')
  assert.equal(drop?.src, 'https://site.example/a/b/movie.webm')
})

test('detectMediaDrop ignores non-media drags (plain link) — null', () => {
  const drop = detectMediaDrop(
    dt(['text/html', 'text/uri-list'], {
      'text/html': '<a href="https://example.com/article">Article</a>',
      'text/uri-list': 'https://example.com/article',
    }),
    null,
  )
  assert.equal(drop, null)
})

test('detectMediaDrop refuses non-http(s) and unparseable URLs', () => {
  assert.equal(detectMediaDrop(dt(['text/uri-list'], { 'text/uri-list': 'file:///etc/passwd.png' }), null), null)
  assert.equal(detectMediaDrop(dt(['text/uri-list'], { 'text/uri-list': 'javascript:alert(1)' }), null), null)
})

test('extractMediaUrlFromHtml reads double and single quoted srcs', () => {
  assert.equal(extractMediaUrlFromHtml("<img src='https://a.example/x.png'>")?.url, 'https://a.example/x.png')
  assert.equal(extractMediaUrlFromHtml('<img src="https://a.example/x.png">')?.tag, 'img')
  assert.equal(extractMediaUrlFromHtml('<div>no media</div>'), null)
})

test('mediaKindOfUrl only accepts http(s) media extensions', () => {
  assert.equal(mediaKindOfUrl('https://a.example/pic.svg'), 'svg')
  assert.equal(mediaKindOfUrl('ftp://a.example/pic.png'), null)
  assert.equal(mediaKindOfUrl('https://a.example/page'), null)
})

/* ------------------------------------------------------------------ */
/* 2 — OKLCH color math + X-Ray Markdown (Plugin A)                    */
/* ------------------------------------------------------------------ */

test('rgbToOklch reproduces known CSS Color 4 reference values', () => {
  const red = rgbToOklch(255, 0, 0)
  assert.ok(Math.abs(red.l - 0.6279554) < 1e-6, `red L ${red.l}`)
  assert.ok(Math.abs(red.c - 0.2576833) < 1e-6, `red C ${red.c}`)
  assert.ok(Math.abs(red.h - 29.2338) < 1e-2, `red H ${red.h}`)
  const white = rgbToOklch(255, 255, 255)
  assert.ok(Math.abs(white.l - 1) < 1e-6)
  assert.ok(white.c < 1e-6)
})

test('formatOklch emits compact CSS oklch()', () => {
  assert.equal(formatOklch(255, 0, 0), 'oklch(62.8% 0.2577 29.2)')
})

test('formatColorPair renders HEX and OKLCH for computed rgb() and hex values', () => {
  const pair = formatColorPair('rgb(24, 24, 28)')
  assert.match(pair, /^#18181c · oklch\(/)
  const hexPair = formatColorPair('#FFFFFF')
  assert.match(hexPair, /^#ffffff · oklch\(100/)
})

test('hexToRgbChannels parses 3/6/8-digit hex and rejects the rest', () => {
  assert.deepEqual(hexToRgbChannels('#fff'), { r: 255, g: 255, b: 255, a: 1 })
  assert.deepEqual(hexToRgbChannels('#18181C'), { r: 24, g: 24, b: 28, a: 1 })
  assert.equal(hexToRgbChannels('#18181C80')?.a ?? 0, 128 / 255)
  assert.equal(hexToRgbChannels('rgb(1,2,3)'), null)
})

test('firstCubicBezier extracts the easing token or null', () => {
  assert.equal(firstCubicBezier('opacity 200ms cubic-bezier(0.4, 0, 0.2, 1)'), 'cubic-bezier(0.4, 0, 0.2, 1)')
  assert.equal(firstCubicBezier('none'), null)
  assert.equal(firstCubicBezier(null), null)
})

test('formatXrayMarkdown emits the typography/color/motion capture sections', () => {
  const markdown = formatXrayMarkdown({
    selector: 'h1.title',
    fontFamily: '"Klim Söhne", sans-serif',
    resolvedFamily: 'Klim Söhne',
    fontWeight: '600',
    fontSize: '32px',
    lineHeight: '38px',
    letterSpacing: '-0.01em',
    color: 'rgb(24, 24, 28)',
    backgroundColor: 'rgb(255, 255, 255)',
    transition: 'opacity 200ms cubic-bezier(0.4, 0, 0.2, 1)',
    easing: null,
    url: 'https://example.com/spec',
  })
  assert.match(markdown, /^## Token capture — `h1\.title`$/m)
  assert.match(markdown, /- family: "Klim Söhne" \(from "Klim Söhne", sans-serif\)/)
  assert.match(markdown, /- weight: 600 · size: 32px · line-height: 38px/)
  assert.match(markdown, /#18181c · oklch\(/)
  assert.match(markdown, /#ffffff · oklch\(/)
  assert.match(markdown, /cubic-bezier\(0\.4, 0, 0\.2, 1\)/)
  assert.match(markdown, /Captured from https:\/\/example\.com\/spec/)
})

/* ------------------------------------------------------------------ */
/* 3 — media clip node title (types.ts)                                */
/* ------------------------------------------------------------------ */

test('mediaClipTitle prefers the source filename, falls back to kind · domain', () => {
  assert.equal(mediaClipTitle({ kind: 'image', clipId: 'png-abc', src: 'https://cdn.example/img/hero-shot.png', sourcePageUrl: 'https://example.com/x', bytes: 1, mime: 'image/png', ext: 'png' }), 'hero-shot.png')
  assert.equal(
    mediaClipTitle({ kind: 'svg', clipId: 'svg-abc', src: '', sourcePageUrl: 'https://specimen.example/page', bytes: 1, mime: 'image/svg+xml', ext: 'svg' }),
    'svg · specimen.example',
  )
  assert.equal(mediaClipTitle({ kind: 'video', clipId: 'webm-abc', src: '', sourcePageUrl: null, bytes: 0, mime: 'video/webm', ext: 'webm' }), 'video clip')
})

/* ------------------------------------------------------------------ */
/* 4 — main's pure plugin model (studio-plugins-model.js)              */
/* ------------------------------------------------------------------ */

test('normalizeClipRequest validates remote sources and refuses hostile ones', () => {
  const good = mainModel.normalizeClipRequest({ src: 'https://cdn.example/a.png', sourcePageUrl: 'https://example.com/', mediaKind: 'image' })
  assert.equal(good.ok, true)
  assert.equal(good.req.src, 'https://cdn.example/a.png')
  assert.equal(mainModel.normalizeClipRequest({ src: 'file:///etc/passwd', mediaKind: 'image' }).ok, false)
  assert.equal(mainModel.normalizeClipRequest({ src: 'https://x.example/a', mediaKind: 'weapon' }).ok, false)
  assert.equal(mainModel.normalizeClipRequest({ src: '', mediaKind: 'image' }).ok, false)
})

test('normalizeClipRequest accepts capped inline svg markup and refuses scripts', () => {
  const ok = mainModel.normalizeClipRequest({ src: '', mediaKind: 'svg', markup: '<svg viewBox="0 0 1 1"></svg>' })
  assert.equal(ok.ok, true)
  assert.equal(ok.req.kind, 'svg')
  assert.equal(mainModel.normalizeClipRequest({ src: '', mediaKind: 'svg', markup: '<svg><script>alert(1)</script></svg>' }).ok, false)
  assert.equal(mainModel.normalizeClipRequest({ src: '', mediaKind: 'svg', markup: '<div>not svg</div>' }).ok, false)
  assert.equal(mainModel.normalizeClipRequest({ src: '', mediaKind: 'svg', markup: '' }).ok, false)
})

test('extForMime maps the MIME allowlist and refuses everything else', () => {
  assert.equal(mainModel.extForMime('image/png; charset=binary'), 'png')
  assert.equal(mainModel.extForMime('image/svg+xml'), 'svg')
  assert.equal(mainModel.extForMime('video/webm'), 'webm')
  assert.equal(mainModel.extForMime('text/html'), null)
  assert.equal(mainModel.extForMime('application/octet-stream'), null)
})

test('normalizeWebmStoreRequest bounds the base64 payload', () => {
  const ok = mainModel.normalizeWebmStoreRequest({ bytes: Buffer.from('RIFF0000WEBMVPCK', 'utf8').toString('base64'), sourcePageUrl: 'https://example.com/' })
  assert.equal(ok.ok, true)
  assert.equal(mainModel.normalizeWebmStoreRequest({ bytes: 'not base64!!!' }).ok, false)
  assert.equal(mainModel.normalizeWebmStoreRequest({ bytes: '' }).ok, false)
})

test('breakpoint policy accepts exactly 1440/1024/768/375, null to disable', () => {
  assert.deepEqual([...mainModel.EMULATE_WIDTHS], [...BREAKPOINT_PRESETS])
  assert.equal(mainModel.normalizeEmulateWidth(768), 768)
  assert.equal(mainModel.normalizeEmulateWidth(800), undefined)
  assert.equal(mainModel.normalizeEmulateWidth(null), null)
})

test('in-page X-Ray scripts are self-teardown-able and idempotent', () => {
  const arm = mainModel.xrayArmScript()
  assert.match(arm, /__spatialXrayArmed/)
  assert.match(arm, /__spatialXrayTeardown/)
  assert.match(mainModel.xrayTeardownScript(), /__spatialXrayTeardown/)
  assert.match(mainModel.shaderHudArmScript(), /__spatialShaderHudArmed/)
  assert.match(mainModel.shaderHudTeardownScript(), /__spatialShaderHudTeardown/)
})
