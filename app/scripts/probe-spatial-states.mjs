// Leaves the window in a chosen state for the PrintWindow capture.
import puppeteer from 'puppeteer-core'
const target = process.argv[2] ?? 'canvas'
const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null })
const spatial = (await browser.pages()).find((p) => p.url().startsWith('blanc-chrome://spatial/'))
if (target === 'canvas') {
  await spatial.evaluate(() => window.spatialAPI.setMode('canvas'))
} else if (target === 'guard') {
  await spatial.evaluate(() => window.spatialAPI.openNode('00000000-0000-4000-8000-000000000001'))
  await new Promise((r) => setTimeout(r, 1500))
  await spatial.evaluate(() => window.spatialAPI.zorderEngage())
} else {
  await spatial.evaluate(() => window.spatialAPI.zorderRelease())
  await spatial.evaluate(() => window.spatialAPI.openNode('00000000-0000-4000-8000-000000000001'))
}
await new Promise((r) => setTimeout(r, 2500))
browser.disconnect()
console.log(`state=${target}`)
