// CDP verification for the Spatial shell running as the real window chrome.
// Requires the browser launched with --remote-debugging-port=9222.
//
//   (browser/) node node_modules/electron/cli.js . --remote-debugging-port=9222
//   (app/)     node scripts/verify-spatial-shell.mjs
//
// Proves, against the LIVE spatial document:
//   1. window.spatialAPI exists and exposes the bridge surface,
//   2. Cmd/Ctrl+Space toggles Mode A → Mode B through the real key path,
//   3. spatialAPI.openNode opens the seed node through the real IPC path
//      (main creates/wakes the WebContentsView and positions it below the
//      top bar, right of the rail),
//   4. the z-order guard engages (static backdrop + hidden live view) and
//     releases cleanly.
import puppeteer from 'puppeteer-core'

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null })
const pages = await browser.pages()
const spatial = pages.find((p) => p.url().startsWith('blanc-chrome://spatial/'))
if (!spatial) { console.error('spatial target not found'); process.exit(1) }
await spatial.bringToFront()

const api = await spatial.evaluate(() => ({
  hasSpatialAPI: typeof window.spatialAPI === 'object',
  fns: window.spatialAPI
    ? ['load', 'mutate', 'openNode', 'closeNode', 'navigate', 'setMode', 'setChromeLayout',
      'zorderEngage', 'zorderRelease', 'storeThumb', 'win',
      'onGraphUpdated', 'onZorderBackdrop', 'onModeChanged', 'onActiveChanged', 'onThumbCapture']
      .map((k) => `${k}:${typeof window.spatialAPI[k]}`)
    : null,
}))
console.log('bridge:', JSON.stringify(api, null, 1))

const loaded = await spatial.evaluate(() => window.spatialAPI.load())
console.log('graph load ok:', loaded?.ok, 'nodes:', loaded?.graph?.nodes?.length)

// Mode B: real key path (App §10 handler → toggleCanvas → bridge setMode).
await spatial.keyboard.down('Control')
await spatial.keyboard.press('Space')
await spatial.keyboard.up('Control')
await new Promise((r) => setTimeout(r, 2000))
await spatial.screenshot({ path: 'D:/Fivem/new brosser/browser/spatial-shell-modeB.png' })
console.log('modeB captured')

// Wake the seed node through the real IPC path.
const opened = await spatial.evaluate(() =>
  window.spatialAPI.openNode('00000000-0000-4000-8000-000000000001'))
console.log('openNode:', JSON.stringify(opened))
await new Promise((r) => setTimeout(r, 2500))
// NOTE: a CDP page screenshot composites only the window document's own
// surface — native WebContentsView children never appear in it. The
// full-composition capture (PrintWindow) is taken afterwards by the caller.
await spatial.screenshot({ path: 'D:/Fivem/new brosser/browser/spatial-shell-node-open-dom.png' })
console.log('node-open (DOM surface) captured — native view needs PrintWindow')

// Z-order guard: engage → static backdrop + hidden live view; release → back.
await spatial.evaluate(() => window.spatialAPI.zorderEngage())
await new Promise((r) => setTimeout(r, 1500))
await spatial.screenshot({ path: 'D:/Fivem/new brosser/browser/spatial-shell-guard.png' })
await spatial.evaluate(() => window.spatialAPI.zorderRelease())
await new Promise((r) => setTimeout(r, 800))
console.log('guard cycle done — window left in Mode A for the PrintWindow capture')
browser.disconnect()
console.log('done')
