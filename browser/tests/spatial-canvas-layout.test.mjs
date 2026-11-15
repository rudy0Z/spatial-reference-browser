// node --test suite for the pure spatial layout module (no Electron).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  TOP_BAR_HEIGHT,
  RAIL_WIDTH_OPEN,
  RAIL_WIDTH_COLLAPSED,
  MODE_B_THUMB,
  modeAViewBounds,
  sanitizeChromeLayout,
  roundRect,
  isCanvasMode,
} = require('../src/main/spatial/canvas-layout.js')

test('chrome geometry constants match the Phase 3 spec', () => {
  assert.equal(TOP_BAR_HEIGHT, 48)
  assert.equal(RAIL_WIDTH_OPEN, 224)
  assert.equal(RAIL_WIDTH_COLLAPSED, 0)
  assert.deepEqual(MODE_B_THUMB, { width: 640, height: 400 })
})

test('modeAViewBounds derives the default viewport below the top bar and right of the rail', () => {
  assert.deepEqual(
    modeAViewBounds({ windowWidth: 1280, windowHeight: 800 }),
    { x: 224, y: 48, width: 1056, height: 752 },
  )
})

test('modeAViewBounds collapses the rail to the full window width', () => {
  assert.deepEqual(
    modeAViewBounds({ windowWidth: 1280, windowHeight: 800, railWidth: 0 }),
    { x: 0, y: 48, width: 1280, height: 752 },
  )
})

test('modeAViewBounds prefers a usable renderer-measured viewport rect', () => {
  assert.deepEqual(
    modeAViewBounds({
      windowWidth: 1280,
      windowHeight: 800,
      viewportRect: { x: 230, y: 60, width: 1020.4, height: 720.6 },
    }),
    { x: 230, y: 60, width: 1020, height: 721 },
  )
})

test('modeAViewBounds clamps an out-of-window renderer rect', () => {
  assert.deepEqual(
    modeAViewBounds({
      windowWidth: 1280,
      windowHeight: 800,
      viewportRect: { x: -50, y: -10, width: 1400, height: 900 },
    }),
    { x: 0, y: 0, width: 1280, height: 800 },
  )
  // A degenerate DOM report (too small to be a real viewport) falls back to
  // the derived default geometry — the page view must never be parked hidden
  // by a broken rect.
  assert.deepEqual(
    modeAViewBounds({ windowWidth: 1280, windowHeight: 800, viewportRect: { x: 2000, y: 0, width: 100, height: 100 } }),
    { x: 224, y: 48, width: 1056, height: 752 },
  )
})

test('modeAViewBounds rejects unusable windows; degenerate rects fall back to defaults', () => {
  assert.equal(modeAViewBounds({ windowWidth: 0, windowHeight: 800 }), null)
  assert.equal(modeAViewBounds({}), null)
  // Even in a tiny window, the derived default keeps a (small) usable view.
  assert.deepEqual(
    modeAViewBounds({ windowWidth: 400, windowHeight: 300, viewportRect: { x: 224, y: 48, width: 100, height: 100 } }),
    { x: 224, y: 48, width: 176, height: 252 },
  )
})

test('sanitizeChromeLayout clamps hostile values and falls back safely', () => {
  assert.deepEqual(sanitizeChromeLayout({ topBarHeight: 9999, railWidth: -50, mode: 'canvas' }), {
    topBarHeight: 120,
    railWidth: 0,
    mode: 'canvas',
  })
  // Unknown mode falls back to reading so views can never be parked hidden.
  assert.equal(sanitizeChromeLayout({ mode: 'garbage' }).mode, 'reading')
  assert.equal(sanitizeChromeLayout(null).mode, 'reading')
  assert.equal(sanitizeChromeLayout(null).railWidth, 224)
  assert.equal(sanitizeChromeLayout(null).topBarHeight, 48)
})

test('sanitizeChromeLayout keeps a usable viewport rect and drops an unusable one', () => {
  const good = sanitizeChromeLayout({ viewportRect: { x: 224, y: 48, width: 1000, height: 700 } })
  assert.deepEqual(good.viewportRect, { x: 224, y: 48, width: 1000, height: 700 })
  assert.equal(sanitizeChromeLayout({ viewportRect: { x: 0, y: 0, width: 10, height: 10 } }).viewportRect, undefined)
})

test('roundRect rounds onto whole pixels through x+width', () => {
  assert.deepEqual(roundRect({ x: 10.4, y: 5.5, width: 100.6, height: 50.4 }), {
    x: 10, y: 6, width: 101, height: 50,
  })
  assert.equal(roundRect(null), null)
  assert.equal(roundRect({ x: NaN, y: 0, width: 1, height: 1 }), null)
})

test('isCanvasMode accepts only canvas', () => {
  assert.equal(isCanvasMode('canvas'), true)
  assert.equal(isCanvasMode('reading'), false)
  assert.equal(isCanvasMode(undefined), false)
})
