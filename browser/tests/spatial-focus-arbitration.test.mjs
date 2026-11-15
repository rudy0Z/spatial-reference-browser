// node --test suite for the §B.8.1/§B.8.3/§B.8.5 shell accelerator table
// (pure — no Electron): binding coverage, platform resolution of CmdOrCtrl,
// exact-modifier matching, IME/auto-repeat rejection, scope split.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  SHELL_SHORTCUT_ACTIONS,
  SHELL_SCOPED_ACTIONS,
  MAIN_SCOPED_ACTIONS,
  matchShellShortcut,
} = require('../src/main/spatial/focus-arbitration.js')

const input = (overrides) => ({
  type: 'keyDown',
  key: 'x',
  control: false,
  meta: false,
  alt: false,
  shift: false,
  isAutoRepeat: false,
  isComposing: false,
  ...overrides,
})

test('§B.8.1 shell shortcuts forward on Windows/Linux (CmdOrCtrl = Ctrl)', () => {
  const expect = [
    [{ key: ' ', control: true }, 'canvas'], // CmdOrCtrl+Space (Ctrl on win/linux)
    [{ key: ' ', alt: true }, 'canvas'],     // Alt+Space
    [{ key: 'L', control: true }, 'palette'],
    [{ key: 'l', control: true }, 'palette'],
    [{ key: 's', control: true }, 'rail'],
    [{ key: 'g', control: true, shift: true }, 'glance'],
    [{ key: '/', control: true }, 'shortcuts'],
    [{ key: 'n', alt: true }, 'quick-note'],
    [{ key: 'f', control: true }, 'find'],
    [{ key: 'j', control: true }, 'downloads'],
    [{ key: 'Escape' }, 'escape'],
  ]
  for (const [overrides, action] of expect) {
    assert.equal(matchShellShortcut(input(overrides), { platform: 'win32' })?.action, action, `${JSON.stringify(overrides)} → ${action}`)
    assert.equal(matchShellShortcut(input(overrides), { platform: 'linux' })?.action, action)
    assert.equal(matchShellShortcut(input(overrides), { platform: 'win32' })?.scope, 'shell')
  }
})

test('§B.8.1 shell shortcuts forward on macOS (CmdOrCtrl = Meta)', () => {
  assert.equal(matchShellShortcut(input({ key: 'l', meta: true }), { platform: 'darwin' })?.action, 'palette')
  assert.equal(matchShellShortcut(input({ key: 'l', control: true }), { platform: 'darwin' }), null)
  assert.equal(matchShellShortcut(input({ key: 'g', meta: true, shift: true }), { platform: 'darwin' })?.action, 'glance')
  assert.equal(matchShellShortcut(input({ key: ' ', meta: true }), { platform: 'darwin' })?.action, 'canvas')
})

test('§B.8.3 builder ergonomics are main-scoped', () => {
  const hardReload = matchShellShortcut(input({ key: 'r', control: true, shift: true }), { platform: 'win32' })
  assert.deepEqual(hardReload, { action: 'reload-ignore-cache', scope: 'main' })
  const devtools = matchShellShortcut(input({ key: 'i', control: true, alt: true }), { platform: 'win32' })
  assert.deepEqual(devtools, { action: 'toggle-devtools', scope: 'main' })
  const f12 = matchShellShortcut(input({ key: 'F12' }), { platform: 'win32' })
  assert.deepEqual(f12, { action: 'toggle-devtools', scope: 'main' })
  // macOS DevTools chord stays Cmd+Alt+I (CmdOrCtrl = Meta).
  assert.equal(matchShellShortcut(input({ key: 'i', meta: true, alt: true }), { platform: 'darwin' })?.action, 'toggle-devtools')
})

test('plain page keys and near-miss chords stay with the page', () => {
  const platform = { platform: 'win32' }
  assert.equal(matchShellShortcut(input({ key: 'f' }), platform), null) // unmodified F types
  assert.equal(matchShellShortcut(input({ key: 'l', control: true, shift: true }), platform), null)
  assert.equal(matchShellShortcut(input({ key: 's', control: true, alt: true }), platform), null)
  assert.equal(matchShellShortcut(input({ key: 'n', control: true }), platform), null) // Ctrl+N is Blanc's new window
  assert.equal(matchShellShortcut(input({ key: 'r', control: true }), platform), null) // ordinary reload keeps Blanc's command
  assert.equal(matchShellShortcut(input({ key: 'j', control: true, shift: true }), platform), null)
  assert.equal(matchShellShortcut(input({ key: 'g', shift: true }), platform), null)
  assert.equal(matchShellShortcut(input({ key: 'Escape', shift: true }), platform), null)
})

test('keyUp, auto-repeat and IME composition never arbitrate', () => {
  const platform = { platform: 'win32' }
  assert.equal(matchShellShortcut(input({ key: 'l', control: true, type: 'keyUp' }), platform), null)
  assert.equal(matchShellShortcut(input({ key: 'l', control: true, isAutoRepeat: true }), platform), null)
  assert.equal(matchShellShortcut(input({ key: 'l', control: true, isComposing: true }), platform), null)
  assert.equal(matchShellShortcut(null, platform), null)
  // Only Electron's 'keyDown' events arbitrate — the same strict posture as
  // browser-shortcuts.js matchBrowserShortcut ('rawKeyDown' is Chromium's
  // pre-accelerator pass and is left to the platform).
  assert.equal(matchShellShortcut(input({ key: 'l', control: true, type: 'rawKeyDown' }), platform), null)
})

test('table shape: every action is unique within its scope and both scopes exist', () => {
  // 'canvas' has two bindings (Cmd/Ctrl+Space AND Alt+Space) — uniqueness is
  // over the ACTION ids, not the bindings.
  const shell = new Set(SHELL_SCOPED_ACTIONS)
  assert.equal(shell.size, 9)
  assert.equal(SHELL_SCOPED_ACTIONS.length, 10)
  assert.deepEqual([...shell].sort(), ['canvas', 'downloads', 'escape', 'find', 'glance', 'palette', 'quick-note', 'rail', 'shortcuts'])
  const main = new Set(MAIN_SCOPED_ACTIONS)
  assert.deepEqual([...main].sort(), ['reload-ignore-cache', 'toggle-devtools'])
  for (const binding of SHELL_SHORTCUT_ACTIONS) {
    assert.ok(['shell', 'main'].includes(binding.scope))
    assert.equal(typeof binding.key, 'string')
  }
})
