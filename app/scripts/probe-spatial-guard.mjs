// One-off probe of the z-order guard backdrop element (see verify-spatial-shell.mjs).
import puppeteer from 'puppeteer-core'

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null })
const spatial = (await browser.pages()).find((p) => p.url().startsWith('blanc-chrome://spatial/'))
await spatial.evaluate(() => window.spatialAPI.zorderEngage())
await new Promise((r) => setTimeout(r, 2000))
const state = await spatial.evaluate(() => {
  const el = document.getElementById('spatial-zorder-backdrop')
  return {
    exists: Boolean(el),
    display: el?.style.display,
    srcLen: el?.src?.length ?? 0,
    srcPrefix: el?.src?.slice(0, 30) ?? null,
    naturalW: el?.naturalWidth ?? 0,
  }
})
console.log('backdrop state:', JSON.stringify(state))
await spatial.evaluate(() => window.spatialAPI.zorderRelease())
await new Promise((r) => setTimeout(r, 500))
const after = await spatial.evaluate(() => {
  const el = document.getElementById('spatial-zorder-backdrop')
  return { display: el?.style.display }
})
console.log('after release:', JSON.stringify(after))
browser.disconnect()
