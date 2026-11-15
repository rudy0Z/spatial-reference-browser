// Headless smoke test for studio-plugins.js (§B.10) — fake deps, no Electron.
// Exercises: channel registration, activation gating (inject only while
// active), teardown on deactivate, media cache policy wiring, emulate +
// preview refusal paths. Run: node audits/phase36-engine-smoke.mjs
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { createStudioPlugins } = require('../browser/src/main/spatial/studio-plugins.js')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spatial-plugins-'))

const fakeWc = () => {
  const executed = []
  return {
    executed,
    isDestroyed: () => false,
    executeJavaScript: (script) => {
      executed.push(script)
      return Promise.resolve(undefined)
    },
    on: () => {},
    once: () => {},
  }
}

const channels = new Map()
// ipcMain.handle invokes handler(event, ...args) — mimic that wrapping so
// the (...args) => args[1] payload convention matches production exactly.
const chromeHandle = (channel, handler) => channels.set(channel, (payload) => handler({}, payload))
const sent = []
const view = { tabId: 1, wc: fakeWc() }

const engine = createStudioPlugins({
  chromeHandle,
  chromeOn: () => {},
  getActiveView: () => view,
  iterViews: () => [view],
  notifyShell: (channel, payload) => sent.push({ channel, payload }),
  userDataPath: tmp,
  viewForNode: () => null,
  captureView: () => Promise.resolve(null),
})

engine.register()

// 1 — list: everything off (0 px, 0 MB baseline)
const list = channels.get('spatial:plugins:list')()
assert.deepEqual(
  list.plugins.map((p) => p.id),
  ['xray', 'media-clip', 'shader-hud', 'split-compare'],
)
assert.ok(list.plugins.every((p) => p.active === false), 'all plugins start off')

// 2 — activation injects ONLY that plugin's script into attached views
const result = channels.get('spatial:plugins:set-active')({ id: 'xray', active: true })
assert.equal(result.ok, true)
assert.ok(view.wc.executed.some((s) => s.includes('__spatialXrayArmed')), 'xray arm script injected')
assert.ok(!view.wc.executed.some((s) => s.includes('__spatialShaderHudArmed')), 'shader hud NOT injected')
assert.deepEqual(sent.at(-1).payload.plugins.find((p) => p.id === 'xray'), { id: 'xray', active: true })

// 3 — deactivation tears the instrumentation down
channels.get('spatial:plugins:set-active')({ id: 'xray', active: false })
assert.ok(view.wc.executed.at(-1).includes('__spatialXrayTeardown'), 'teardown script executed')

// 4 — invalid ids and widths are refused
assert.equal(channels.get('spatial:plugins:set-active')({ id: 'evil', active: true }).ok, false)
assert.equal(channels.get('spatial:plugins:emulate')({ uuid: 'x', width: 800 }).ok, false, 'non-preset width refused')
assert.equal(channels.get('spatial:plugins:emulate')({ uuid: '00000000-0000-4000-8000-000000000001', width: 768 }).ok, false, 'no view refused')

// 5 — media cache: refuse hostile (async handler — await like ipcMain.handle does)
const refused = await channels.get('spatial:media:cache')({ src: 'file:///etc/passwd', mediaKind: 'image' })
assert.equal(refused.ok, false)

// 6 — media read: clip-id traversal is refused
assert.equal(channels.get('spatial:media:read')({ clipId: '../secret' }).ok, false)
assert.equal(channels.get('spatial:media:read')({ clipId: '' }).ok, false)

// 7 — webm store: garbage refused, real bytes written to userData/media/
const badWebm = channels.get('spatial:media:store-webm')({ bytes: '!!!not-base64!!!', sourcePageUrl: null })
assert.equal(badWebm.ok, false)
const png1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
// MediaRecorder would emit webm; content is opaque bytes to the store — write a tiny valid base64 blob
const stored = channels.get('spatial:media:store-webm')({ bytes: png1x1.toString('base64'), sourcePageUrl: 'https://example.com/' })
assert.equal(stored.ok, true)
assert.equal(stored.clip.kind, 'video')
assert.equal(stored.clip.ext, 'webm')
const mediaDir = path.join(tmp, 'media')
const written = fs.readdirSync(mediaDir)
assert.equal(written.length, 1, 'exactly one clip file written')
assert.match(written[0], /^preview-.*\.webm$/)

// 8 — read-back: the stored clip resolves as a data URL through the validated path
const readBack = channels.get('spatial:media:read')({ clipId: stored.clip.clipId })
// read-back iterates the EXT_MIME allowlist — webm is allowlisted, so it resolves
assert.equal(readBack.ok, true)
assert.match(readBack.dataUrl, /^data:video\/webm;base64,/)

// 9 — attachView injects while active, not while off
channels.get('spatial:plugins:set-active')({ id: 'shader-hud', active: true })
const second = { tabId: 2, wc: fakeWc() }
engine.attachView(2, second.wc)
assert.ok(second.wc.executed.some((s) => s.includes('__spatialShaderHudArmed')), 'new view covered while active')
engine.forgetView(2)

console.log('phase36 engine smoke: ALL OK')
