// Probe: the bridge's AUTOMATIC thumbnail path — no manual listeners.
import puppeteer from 'puppeteer-core'
const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null })
const spatial = (await browser.pages()).find((p) => p.url().startsWith('blanc-chrome://spatial/'))
await spatial.evaluate(() => window.spatialAPI.openNode('00000000-0000-4000-8000-000000000001'))
await new Promise((r) => setTimeout(r, 2000))
await spatial.evaluate(() => window.spatialAPI.setMode('canvas'))
await new Promise((r) => setTimeout(r, 3500))
const graph = await spatial.evaluate(() => window.spatialAPI.load())
const node = graph?.graph?.nodes?.[0]
console.log('auto thumb:', node?.thumb ? `OK len=${node.thumb.length} prefix=${node.thumb.slice(0, 22)}` : 'NONE')
console.log('dims ok:', node?.thumb ? JSON.stringify({ w: node.w, h: node.h }) : '-')
await spatial.evaluate(() => window.spatialAPI.openNode('00000000-0000-4000-8000-000000000001'))
await new Promise((r) => setTimeout(r, 800))
browser.disconnect()
