// Master spec Phase 1.5 §2.3 — REAL headless-CDP fps benchmark.
//
// Builds the production bundle, serves it with `vite preview`, then launches
// the locally installed Chrome/Edge in new-headless mode (a real compositor
// that delivers BeginFrames — unlike the in-app browser harness, which
// provably suspends rAF: see audits/phase-1.5-clean-design-audit.md), loads
// the app, seeds exactly 700 nodes through the dev-only
// `window.__devStressSeed()` hook, and samples requestAnimationFrame deltas
// for 5 seconds while a pan/zoom wheel storm runs against
// `.react-flow__pane`.
//
// Why production, not the dev server: dev mode runs React StrictMode
// (double renders), unminified code and on-demand transforms — measured
// run-to-run variance exceeded 60%, swamping the gate. The shipped artifact
// is what the gate is about.
//
// Gate (never invented): sustained >= 55 fps AND dropped (delta > 33ms) < 2%.
// Exit 0 = pass · 1 = gate fail · 2 = environment error.
//
// Usage: npm run bench:fps   (builds, spawns and reaps its own server)

import fs from 'node:fs'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AUDITS_DIR = path.resolve(APP_ROOT, '..', 'audits')
const APP_URL = 'http://127.0.0.1:5199/'
const SEED_COUNT = 700
const SETTLE_MS = 3000
const BENCH_MS = 5000
const FPS_GATE = 55
const DROPPED_GATE_PCT = 2
const DROPPED_DELTA_MS = 33

function log(msg) {
  console.log(`[bench] ${msg}`)
}

function findBrowserExecutable() {
  const candidates = [
    process.env.SPATIAL_BENCH_BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe` : null,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function httpStatus(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', () => resolve(0))
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      resolve(0)
    })
  })
}

async function waitForServer(url, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const status = await httpStatus(url)
    if (status === 200) return true
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return false
}

async function main() {
  const executablePath = findBrowserExecutable()
  if (!executablePath) {
    console.error('[bench] ENV ERROR: no Chrome/Edge executable found (set SPATIAL_BENCH_BROWSER).')
    process.exit(2)
  }
  log(`browser: ${executablePath}`)

  // 1. Build the production bundle, then serve it with vite preview.
  let server = null
  if (await waitForServer(APP_URL, 1000)) {
    log('something already answers on :5199 — refusing to share the port')
    process.exit(2)
  }
  log('building production bundle (vite build)')
  const build = spawnSync(process.execPath, [path.join(APP_ROOT, 'node_modules/vite/bin/vite.js'), 'build', APP_ROOT], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300000,
  })
  if (build.status !== 0) {
    console.error(`[bench] ENV ERROR: vite build failed (exit ${build.status})`)
    console.error(String(build.stderr).slice(-2000))
    process.exit(2)
  }
  log('serving dist via vite preview on :5199')
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', APP_ROOT, '--port', '5199', '--strictPort'], {
    cwd: APP_ROOT,
    stdio: 'ignore',
  })
  if (!(await waitForServer(APP_URL, 30000))) {
    console.error('[bench] ENV ERROR: preview server did not come up on :5199')
    server.kill()
    process.exit(2)
  }

  let browser = null
  try {
    // 2. Fresh headless browser, fresh profile.
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ['--window-size=1600,900', '--disable-infobars', '--hide-scrollbars'],
      defaultViewport: { width: 1600, height: 900 },
    })
    const page = await browser.newPage()
    page.on('pageerror', (err) => log(`pageerror: ${String(err).slice(0, 160)}`))

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
    // Fresh-State law: a clean profile boots the empty first run; clear any
    // storage anyway so the measurement is always from the clean state.
    await page.evaluate(() => localStorage.clear())
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForSelector('#root > *', { timeout: 30000 })
    log('app loaded (clean first-run state, reading mode)')

    // 3. Seed exactly 700 nodes — applySeed also lands us in canvas mode at
    // zoom 0.30, which mounts the React Flow canvas. The store count is the
    // truth gate: `onlyRenderVisibleElements` culls the DOM to the viewport,
    // so DOM node count is NOT the graph size.
    const seededCount = await page.evaluate(() => window.__devStressSeed())
    if (seededCount !== SEED_COUNT) {
      console.error(`[bench] ENV ERROR: seed produced ${seededCount} nodes, expected ${SEED_COUNT}`)
      process.exitCode = 2
      return
    }
    await page.waitForSelector('.react-flow__viewport', { timeout: 30000 })
    log(`seeded: ${SEED_COUNT} nodes in the graph (canvas mode, DOM culls to viewport)`)

    // 4. Settle the force layout before sampling.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))

    // Optional CPU attribution: --profile wraps the storm in a CDP sampler
    // and dumps the top self-time functions to audits/fps-cpu-profile.json.
    const profiling = process.argv.includes('--profile')
    const cdp = await page.createCDPSession()
    if (profiling) {
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
      await cdp.send('Profiler.start')
    }

    // 5. The 5-second pan/zoom storm with rAF delta sampling.
    const { deltas, wheelCount } = await page.evaluate(
      (benchMs) =>
        new Promise((resolve) => {
          const pane = document.querySelector('.react-flow__pane')
          if (!pane) {
            resolve({ deltas: [], wheelCount: 0, error: 'no .react-flow__pane' })
            return
          }
          const deltas = []
          let last = performance.now()
          let wheels = 0
          const wheelTimer = setInterval(() => {
            wheels += 1
            // Alternating zoom keeps the camera level (no drift to an empty
            // corner); the horizontal component pans across the graph.
            pane.dispatchEvent(
              new WheelEvent('wheel', {
                deltaY: wheels % 2 === 0 ? -120 : 120,
                deltaX: wheels % 2 === 0 ? 40 : -40,
                clientX: window.innerWidth / 2,
                clientY: window.innerHeight / 2,
                bubbles: true,
                cancelable: true,
              }),
            )
          }, 16)
          const startedAt = performance.now()
          let raf = 0
          function frame(now) {
            deltas.push(now - last)
            last = now
            if (now - startedAt < benchMs) {
              raf = requestAnimationFrame(frame)
            } else {
              clearInterval(wheelTimer)
              cancelAnimationFrame(raf)
              resolve({ deltas, wheelCount: wheels })
            }
          }
          raf = requestAnimationFrame(frame)
        }),
      BENCH_MS,
    )

    // 6. The numbers, computed honestly.
    // Stop the CPU sampler before computing the numbers.
    let topFunctions = []
    if (profiling) {
      const { profile } = await cdp.send('Profiler.stop')
      const byId = new Map(profile.nodes.map((n) => [n.id, n]))
      const selfHits = new Map()
      for (const node of profile.nodes) {
        const hit = node.hitCount ?? 0
        if (hit === 0) continue
        const url = (node.callFrame.url || '(native)').replace(/^.*\//, '')
        const label = `${node.callFrame.functionName || '(anonymous)'} @ ${url}:${node.callFrame.lineNumber + 1}`
        selfHits.set(label, (selfHits.get(label) ?? 0) + hit)
      }
      topFunctions = [...selfHits.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([label, hits]) => ({ label, hits }))
      const totalSamples = [...selfHits.values()].reduce((s, h) => s + h, 0)
      topFunctions = topFunctions.map((t) => ({ ...t, pct: Math.round((t.hits / totalSamples) * 1000) / 10 }))
      fs.writeFileSync(
        path.join(AUDITS_DIR, 'fps-cpu-profile.json'),
        JSON.stringify({ topFunctions, totalSamples }, null, 2),
      )
      log(`cpu profile: ${totalSamples} samples → audits/fps-cpu-profile.json`)
    }

    const totalMs = deltas.reduce((sum, d) => sum + d, 0)
    const frames = deltas.length
    const avgFps = totalMs > 0 ? (frames / totalMs) * 1000 : 0
    const dropped = deltas.filter((d) => d > DROPPED_DELTA_MS).length
    const droppedPct = frames > 0 ? (dropped / frames) * 100 : 100
    const p95 = deltas.length > 0 ? [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length * 0.95)] : 0
    const pass = avgFps >= FPS_GATE && droppedPct < DROPPED_GATE_PCT

    const report = {
      benchmark: 'phase-1.5 headless-CDP canvas fps',
      date: new Date().toISOString(),
      url: APP_URL,
      browser: path.basename(executablePath),
      nodes: SEED_COUNT,
      benchMs: BENCH_MS,
      wheelEvents: wheelCount,
      frames,
      avgFps: Math.round(avgFps * 10) / 10,
      droppedPct: Math.round(droppedPct * 100) / 100,
      p95FrameMs: Math.round(p95 * 10) / 10,
      topFunctions: topFunctions.slice(0, 8),
      gates: { fps: FPS_GATE, droppedPct: DROPPED_GATE_PCT, droppedDeltaMs: DROPPED_DELTA_MS },
      pass,
    }

    fs.mkdirSync(AUDITS_DIR, { recursive: true })
    const reportPath = path.join(AUDITS_DIR, 'fps-bench-latest.json')
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    log(`frames=${frames} avgFps=${report.avgFps} droppedPct=${report.droppedPct}% p95=${report.p95FrameMs}ms wheels=${wheelCount}`)
    log(`report: ${reportPath}`)
    log(`GATE: ${pass ? 'PASS' : 'FAIL'} (need >= ${FPS_GATE} fps, < ${DROPPED_GATE_PCT}% dropped)`)
    process.exitCode = pass ? 0 : 1
  } catch (err) {
    console.error(`[bench] ENV ERROR: ${err?.stack ?? err}`)
    process.exitCode = 2
  } finally {
    if (browser) await browser.close()
    if (server) server.kill()
  }
}

await main()
