// Stage I — spec B.12 integrated probe (headless-able subset), driven over CDP
// against the LIVE fork. Companion to verify-spatial-shell.mjs.
//
// Launch first (browser/):  node node_modules/electron/cli.js . --remote-debugging-port=9222
// Then run here (app/):     node scripts/probe-spatial-b12.mjs
//
// Exercises (spec B.12 items 1 + 3):
//   1. Trail capture: Ctrl+Click a link inside the live view (the user-requested
//      branch path, main.js onSpatialBranch) → child node with provenance
//      (anchorText/contextSnippet/scrollYAtSpawn) + spawn edge; parent/child on
//      distinct domains (127.0.0.1 vs localhost).
//   2. Zapper: zapArm → in-page __spatialZapArmed verified → real Alt+Shift+Click
//      → __spatialZapResult + domain mod record → view reload → mod re-injected
//      (element hidden) and selector still persisted.
//   3. X-Ray → StickyNote: pluginsSetActive('xray') → __spatialXrayArmed →
//      hover+click a heading → token snapshot → shell writes StickyNote → read
//      back via the Phase 3.7 MCP bridge (search_spatial_graph).
//   4. Image → media node: media-clip plugin on → the shell's REAL drop handler
//      receives a synthetic DragEvent with an <img> payload → media card node +
//      cached clip (mediaReadClip ok).
//
// NOT exercisable headless (founder runs interactively): the native OS drag
// gesture itself, Alt+Hover chain illumination as rendered UI, Island Continuum
// visuals (dot-morph peek, dual-horizon deck, elastic transition, satellite
// notch hover/click), Stage 1→2 expansion, and plumbing on live YouTube/Figma.
import puppeteer from 'puppeteer-core'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

/** Chromium's native occlusion tracker parks occluded windows' pages in
 * visibilityState=hidden and drops CDP input to them. Raise the fork window
 * (pid from the MCP bridge handshake file) so input reaches the views. */
function raiseForkWindow() {
  const candidates = ['Spatial-Dev', 'Spatial', 'Electron']
  for (const name of candidates) {
    const p = path.join(process.env.APPDATA ?? '', name, 'spatial-mcp', 'bridge.json')
    try {
      if (!fs.existsSync(p)) continue
      const { pid } = JSON.parse(fs.readFileSync(p, 'utf8'))
      const ps = `Add-Type 'using System; using System.Runtime.InteropServices; public class W { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n); [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f); }'; $p = Get-Process -Id ${pid} -ErrorAction Stop; $h = $p.MainWindowHandle; [W]::ShowWindow($h, 9) | Out-Null; [W]::SetWindowPos($h, [IntPtr]-1, 0, 0, 1280, 800, 0x0040) | Out-Null; [W]::SetForegroundWindow($h) | Out-Null; Write-Output raised`
      execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { stdio: 'pipe' })
      return true
    } catch { /* next candidate */ }
  }
  return false
}
raiseForkWindow()
await new Promise((r) => setTimeout(r, 2000))

const PORT = 8791
const results = []
const record = (name, status, detail) => {
  results.push({ name, status, detail })
  console.log(`[${status}] ${name} — ${detail}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const IMG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
// Loopback hosts are filter-blocked (ERR_BLOCKED_BY_CLIENT) once the adblock
// engine has warmed — serve on the machine's LAN IPv4s instead. Two distinct
// interface IPs give a true cross-domain pair; with one IP the pair check
// degrades (the trail spawn itself is user-requested and domain-agnostic).
import os from 'node:os'
const lanIps = []
for (const list of Object.values(os.networkInterfaces())) {
  for (const it of list ?? []) {
    if (it.family === 'IPv4' && !it.internal) lanIps.push(it.address)
  }
}
const hostA = lanIps[0] ?? '127.0.0.1'
const hostB = lanIps[1] ?? hostA
const pageA = `<!doctype html><title>Origin A</title>
<h2 id="hd" style="font:700 32px/1.2 Georgia, serif; color:#111">Specimen Heading</h2>
<p id="ctx">Plain context sentence around the link so the snippet has meat. <a href="http://${hostB}:${PORT}/b.html" id="lnk">Read the follow-up analysis</a> and then keep reading.</p>
<img id="pic" src="/img.png" width="40" height="20" alt="probe">`
const pageB = `<!doctype html><title>Page B</title>
<h2 style="font:700 28px/1.3 Georgia, serif">Target B</h2>
<p class="zapme">This paragraph should vanish when zapped.</p>
<img src="/img.png">`
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0]
  if (url === '/img.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(IMG); return }
  const body = url === '/b.html' ? pageB : pageA
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(body)
})
await new Promise((r) => server.listen(PORT, '0.0.0.0', r))
console.log(`[probe] serving on ${hostA}:${PORT} (cross host: ${hostB}:${PORT})`)

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null })
const shell = (await browser.pages()).find((p) => p.url().startsWith('blanc-chrome://spatial/'))
if (!shell) { console.error('FATAL: spatial shell target not found'); process.exit(2) }
await shell.bringToFront()
const findView = async (substr) => (await browser.pages()).find((p) => p.url().includes(substr))
/** All live CDP targets matching a url substring. */
const findViews = async (substr) => (await browser.pages()).filter((p) => p.url().includes(substr))
/** Poll for one matching target (cold starts create views asynchronously). */
const findViewWithRetry = async (substr, tries = 12, gapMs = 1000) => {
  for (let i = 0; i < tries; i++) {
    const hit = await findView(substr)
    if (hit) return hit
    await sleep(gapMs)
  }
  return null
}
/** Re-raise if occlusion parked the page again (input is dropped while hidden). */
const ensureVisible = async (page) => {
  const vis = await page.evaluate(() => document.visibilityState)
  if (vis !== 'visible') { raiseForkWindow(); await sleep(1500) }
  return await page.evaluate(() => document.visibilityState)
}
let branchChildUuid = null

/* seed node → page A, then Ctrl+Click the cross-host anchor */
try {
  await shell.evaluate(async () => { await window.spatialAPI.openNode('00000000-0000-4000-8000-000000000001') })
  await sleep(1200)
  await shell.evaluate(async (u) => { await window.spatialAPI.navigate(u) }, `http://${hostA}:${PORT}/a.html`)
  const viewA = await findViewWithRetry(`:${PORT}/a.html`)
  if (!viewA) record('trail.click', 'FAIL', 'view target for a.html not found')
  else {
    await viewA.bringToFront()
    await ensureVisible(viewA)
    const box = await viewA.evaluate(() => { const r = document.getElementById('lnk').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
    await viewA.keyboard.down('Control')
    await viewA.mouse.click(box.x, box.y) // user-requested branch → onSpatialBranch with provenance
    await viewA.keyboard.up('Control')
    await sleep(3500)
    const graph = await shell.evaluate(async () => await window.spatialAPI.load())
    const nodes = Object.values(graph?.graph?.nodes ?? {})
    // repeated runs leave stale b.html children behind — always take the newest
    const bNodes = nodes.filter((n) => (n.url ?? '').includes('b.html')).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    const child = bNodes[0]
    const parent = nodes.find((n) => (n.url ?? '').includes('a.html'))
    if (!child) record('trail.spawn', 'FAIL', `no b.html node; node urls=${nodes.map((n) => n.url).join(' | ').slice(0, 300)}`)
    else {
      branchChildUuid = child.uuid
      const prov = child.provenance ?? null
      const anchorText = prov?.anchorText ?? null
      const snippet = prov?.contextSnippet ?? null
      const scrollY = prov?.scrollYAtSpawn ?? null
      const okAnchor = anchorText === 'Read the follow-up analysis'
      const okSnippet = typeof snippet === 'string' && snippet.includes('context sentence')
      const okScroll = typeof scrollY === 'number'
      record('trail.spawn', 'PASS', `child node ${child.uuid.slice(0, 8)} spawned on ${(new URL(child.url)).host} (branchKind=${child.branchKind})`)
      record('trail.provenance', okAnchor && okSnippet && okScroll ? 'PASS' : 'FAIL',
        JSON.stringify({ anchorText, snippet: typeof snippet === 'string' ? snippet.slice(0, 60) : snippet, scrollYAtSpawn: scrollY }))
      // the spawn edge lives on the model: parentUuid link + the parent's edges[] list
      const parentLinkOk = parent && child.parentUuid === parent.uuid
      const parentEdgesOk = parent && Array.isArray(parent.edges) && parent.edges.includes(child.uuid)
      record('trail.spawnEdge', parentLinkOk && parentEdgesOk ? 'PASS' : 'FAIL',
        `parentUuid link=${parentLinkOk} parent.edges contains child=${parentEdgesOk} (parent.edges=${JSON.stringify(parent?.edges ?? null).slice(0, 120)})`)
      const parentHost = parent ? new URL(parent.url).host : '?'
      const childHost = new URL(child.url).host
      record('trail.crossDomainPair', parentHost !== childHost ? 'PASS' : 'FAIL',
        `parent=${parentHost} child=${childHost} (distinct hosts = distinct domains)`)
      record('trail.chain', parentLinkOk ? 'PASS' : 'FAIL',
        `Alt+Hover trace data = parent→child chain via parentUuid; collectTrailChain consumes this same chain`)
    }
  }
} catch (err) { record('trail.fatal', 'FAIL', String(err?.message ?? err)) }

/* zapper */
try {
  let viewsB = []
  for (let i = 0; i < 10 && !viewsB.length; i++) { viewsB = await findViews(`:${PORT}/b.html`); if (!viewsB.length) await sleep(1000) }
  if (!viewsB.length) record('zapper.view', 'FAIL', 'no b.html view target')
  else {
    // the zapper arms the ACTIVE view — make the branch child the active node
    if (branchChildUuid) { await shell.evaluate(async (u) => await window.spatialAPI.openNode(u), branchChildUuid); await sleep(1500) }
    for (const v of viewsB) await ensureVisible(v)
    const armed = await shell.evaluate(async () => await window.spatialAPI.zapArm())
    await sleep(1500)
    const armedViews = []
    for (const v of viewsB) { if (await v.evaluate(() => window.__spatialZapArmed === true)) armedViews.push(v) }
    const armedInPage = armedViews.length > 0
    const viewB = armedViews[0] ?? viewsB[0]
    record('zapper.arm', armed?.ok && armed?.armed && armedInPage ? 'PASS' : 'FAIL',
      `bridge=${JSON.stringify(armed)} inPage=__spatialZapArmed=${armedInPage}`)
    if (armedInPage) {
      await viewB.bringToFront()
      await ensureVisible(viewB)
      const box = await viewB.evaluate(() => { const r = document.querySelector('.zapme').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
      await viewB.keyboard.down('Alt'); await viewB.keyboard.down('Shift')
      await viewB.mouse.click(box.x, box.y)
      await viewB.keyboard.up('Shift'); await viewB.keyboard.up('Alt')
      await sleep(1800)
      const zapResult = await viewB.evaluate(() => window.__spatialZapResult ?? null)
      record('zapper.clickCaptured', zapResult ? 'PASS' : 'FAIL', zapResult ? `chain=${JSON.stringify(zapResult.chain?.[0])}` : 'no __spatialZapResult in page')
      const mods = await shell.evaluate(async () => await window.spatialAPI.modsList())
      const rec = (mods?.mods ?? []).find((m) => ((m.domain ?? '').includes(hostA) || (m.domain ?? '').includes(hostB)) && (m.zapSelectors ?? []).length > 0)
      record('zapper.save', rec ? 'PASS' : 'FAIL', rec ? `domain=${rec.domain} selector=${JSON.stringify(rec.zapSelectors)}` : `mods=${JSON.stringify(mods?.mods ?? []).slice(0, 200)}`)
      await viewB.reload()
      await sleep(2200)
      const afterReload = await viewB.evaluate(() => { const el = document.querySelector('.zapme'); return el ? getComputedStyle(el).display : 'element-gone' })
      record('zapper.reapplyAfterReload', afterReload === 'none' ? 'PASS' : 'FAIL', `computed display after reload = ${afterReload}`)
      const mods2 = await shell.evaluate(async () => await window.spatialAPI.modsList())
      const rec2 = (mods2?.mods ?? []).find((m) => ((m.domain ?? '').includes(hostA) || (m.domain ?? '').includes(hostB)) && (m.zapSelectors ?? []).length > 0)
      record('zapper.persisted', rec2 ? 'PASS' : 'FAIL', rec2 ? 'selector still present after reload' : 'selector gone')
    }
    await shell.evaluate(async () => await window.spatialAPI.zapDisarm())
  }
} catch (err) { record('zapper.fatal', 'FAIL', String(err?.message ?? err)) }

/* x-ray → sticky note (read back via MCP bridge) */
try {
  // the x-ray arm script also targets the ACTIVE view — child first
  if (branchChildUuid) { await shell.evaluate(async (u) => await window.spatialAPI.openNode(u), branchChildUuid); await sleep(1500) }
  let viewsX = []
  for (let i = 0; i < 10 && !viewsX.length; i++) { viewsX = await findViews(`:${PORT}/b.html`); if (!viewsX.length) await sleep(1000) }
  for (const v of viewsX) await ensureVisible(v)
  const act = await shell.evaluate(async () => await window.spatialAPI.pluginsSetActive('xray', true))
  await sleep(1800)
  const armedViewsX = []
  for (const v of viewsX) { if (await v.evaluate(() => window.__spatialXrayArmed === true)) armedViewsX.push(v) }
  const viewX = armedViewsX[0] ?? viewsX[0]
  if (!act?.ok || !act?.active) record('xray.activate', 'FAIL', JSON.stringify(act))
  else if (!viewX) record('xray.view', 'FAIL', 'no view target')
  else {
    const armedInPage = armedViewsX.length > 0
    record('xray.activate', armedInPage ? 'PASS' : 'FAIL', `__spatialXrayArmed=${armedInPage}`)
    if (armedInPage) {
      await viewX.bringToFront()
      await ensureVisible(viewX)
      const box = await viewX.evaluate(() => { const r = document.querySelector('h2').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
      await viewX.mouse.move(box.x, box.y)
      await sleep(500)
      await viewX.mouse.click(box.x, box.y)
      await sleep(2200)
      const xrayResult = await viewX.evaluate(() => window.__spatialXrayResult ?? null)
      record('xray.capture', xrayResult ? 'PASS' : 'FAIL', xrayResult ? `fontFamily=${xrayResult.fontFamily} fontSize=${xrayResult.fontSize}` : 'no __spatialXrayResult in page')
      const candidates = ['Spatial-Dev', 'Spatial', 'Electron']
      let bridge = null
      for (const name of candidates) {
        const p = path.join(process.env.APPDATA ?? '', name, 'spatial-mcp', 'bridge.json')
        try { if (fs.existsSync(p)) { bridge = JSON.parse(fs.readFileSync(p, 'utf8')); break } } catch { /* next */ }
      }
      if (!bridge) record('xray.stickyNote', 'FAIL', 'bridge.json not found in any userData candidate')
      else {
        const call = (payload) => new Promise((resolve, reject) => {
          const data = JSON.stringify(payload)
          const req = http.request({ host: '127.0.0.1', port: bridge.port, method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json', authorization: `Bearer ${bridge.token}`, 'content-length': Buffer.byteLength(data) } }, (res) => {
            let buf = ''; res.on('data', (c) => { buf += c }); res.on('end', () => { try { resolve(JSON.parse(buf)) } catch (e) { reject(e) } })
          })
          req.on('error', reject); req.end(data)
        })
        await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'b12-probe', version: '0' } } })
        const search = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_spatial_graph', arguments: { query: 'Georgia', max: 10 } } })
        const text = JSON.stringify(search)
        record('xray.stickyNote', text.toLowerCase().includes('georgia') ? 'PASS' : 'FAIL',
          text.toLowerCase().includes('georgia') ? 'typography spec note found via MCP search_spatial_graph' : `resp=${text.slice(0, 260)}`)
      }
    }
    await shell.evaluate(async () => await window.spatialAPI.pluginsSetActive('xray', false))
  }
} catch (err) { record('xray.fatal', 'FAIL', String(err?.message ?? err)) }

/* image drag → media node (synthetic DragEvent through the real handler) */
try {
  const actM = await shell.evaluate(async () => await window.spatialAPI.pluginsSetActive('media-clip', true))
  await sleep(1800) // let main's authoritative plugin set sync into the shell store
  if (!actM?.ok || !actM?.active) record('media.plugin', 'FAIL', JSON.stringify(actM))
  else {
    const dropped = await shell.evaluate(async (imgUrl) => {
      // the island root carries the drag handlers (FloatingIslandPill motion.div);
      // the compact pill row sits inside it, so bubbling reaches the real handler
      const zones = Array.from(document.querySelectorAll('div')).filter((el) => typeof el.className === 'string' && el.className.includes('pointer-events-auto'))
      const zone = zones.find((el) => el.className.includes('flex-col') && el.className.includes('rounded-'))
        ?? zones.find((el) => el.className.includes('max-h-'))
        ?? zones[zones.length - 1]
      if (!zone) return { ok: false, error: `no pointer-events-auto zone; div classes sample=${Array.from(document.querySelectorAll('div')).slice(0, 12).map((d) => String(d.className).slice(0, 50)).join(' // ')}` }
      const dt = new DataTransfer()
      dt.setData('text/html', `<img src="${imgUrl}" alt="probe">`)
      dt.setData('text/uri-list', imgUrl)
      zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
      return { ok: true, zoneClass: String(zone.className).slice(0, 80) }
    }, `http://${hostA}:${PORT}/img.png`)
    if (!dropped.ok) { record('media.drop', 'FAIL', dropped.error); await shell.evaluate(async () => await window.spatialAPI.pluginsSetActive('media-clip', false)) }
    else {
      // the shell store adopts main's authoritative plugin set asynchronously —
      // re-dispatch until a mediaClip node materializes (bounded poll)
      let clipNode = null
      for (let i = 0; i < 6 && !clipNode; i++) {
        await sleep(2000)
        const graph2 = await shell.evaluate(async () => await window.spatialAPI.load())
        clipNode = Object.values(graph2?.graph?.nodes ?? {}).find((n) => n.mediaClip && (n.mediaClip.src ?? '').includes('img.png')) ?? null
        if (!clipNode) await shell.evaluate(async (imgUrl) => {
          const zones = Array.from(document.querySelectorAll('div')).filter((el) => typeof el.className === 'string' && el.className.includes('pointer-events-auto'))
          const zone = zones.find((el) => el.className.includes('flex-col') && el.className.includes('rounded-')) ?? zones.find((el) => el.className.includes('max-h-')) ?? zones[zones.length - 1]
          if (!zone) return
          const dt = new DataTransfer()
          dt.setData('text/html', `<img src="${imgUrl}" alt="probe">`)
          dt.setData('text/uri-list', imgUrl)
          zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
        }, `http://${hostA}:${PORT}/img.png`)
      }
      if (!clipNode) record('media.clipNode', 'FAIL', 'no node with mediaClip after repeated drops (store-side plugin may never have adopted)')
      else {
        record('media.drop', 'PASS', `synthetic <img> DragEvent(s) dispatched on zone "${dropped.zoneClass}"`)
        const read = await shell.evaluate(async (id) => await window.spatialAPI.mediaReadClip(id), clipNode.mediaClip.clipId)
        record('media.clipNode', read?.ok ? 'PASS' : 'FAIL', `kind=${clipNode.mediaClip.kind} bytes=${clipNode.mediaClip.bytes} mediaReadClip ok=${read?.ok}`)
      }
    }
    await shell.evaluate(async () => await window.spatialAPI.pluginsSetActive('media-clip', false))
  }
} catch (err) { record('media.fatal', 'FAIL', String(err?.message ?? err)) }

server.close()
browser.disconnect()
const failed = results.filter((r) => r.status === 'FAIL')
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) { console.log('FAILURES:'); failed.forEach((f) => console.log(`  - ${f.name}: ${f.detail}`)) }
process.exit(failed.length ? 1 : 0)
