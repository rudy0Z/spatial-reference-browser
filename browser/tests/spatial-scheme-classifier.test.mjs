// node --test suite for the §B.8.2 external-app scheme classifier (pure):
// every spec-listed scheme hands off, web/internal/malformed stay out,
// unsafe characters are refused before any launcher sees them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { APP_SCHEMES, classifyExternalScheme, isAppSchemeUrl } = require('../src/main/spatial/scheme-classifier.js')

test('every §B.8.2 scheme classifies as a handoff with its app name', () => {
  const cases = [
    ['figma://file/Abc123', 'figma:', 'figma'],
    ['vscode://vscode.github-authentication/did-authenticate', 'vscode:', 'vscode'],
    ['cursor://open?url=https://x.test', 'cursor:', 'cursor'],
    ['mailto:someone@example.test?subject=hi', 'mailto:', 'mail'],
    ['discord://-/invite/abc', 'discord:', 'discord'],
    ['spotify:track:4uLU6hCj', 'spotify:', 'spotify'],
    ['slack://channel?id=C123', 'slack:', 'slack'],
  ]
  for (const [url, scheme, app] of cases) {
    const decision = classifyExternalScheme(url)
    assert.deepEqual(decision, { action: 'handoff', scheme, app }, url)
    assert.equal(isAppSchemeUrl(url), true)
  }
  assert.equal(Object.keys(APP_SCHEMES).length, cases.length)
})

test('web, internal and unknown schemes are NOT this lane', () => {
  for (const url of [
    'https://figma.com/file/x',
    'http://example.test/',
    'blanc://newtab/',
    'blanc-chrome://spatial/',
    'chrome://settings/',
    'file:///C:/doc.pdf',
    'data:text/html,hi',
    'javascript:alert(1)',
    'zoommtg://zoom.us/join', // unfamiliar scheme → Blanc's generic consent path
    'msteams://x',
  ]) {
    assert.deepEqual(classifyExternalScheme(url), { action: 'none' }, url)
    assert.equal(isAppSchemeUrl(url), false)
  }
})

test('malformed, oversized and unsafe targets refuse the lane', () => {
  assert.deepEqual(classifyExternalScheme(''), { action: 'none' })
  assert.deepEqual(classifyExternalScheme(null), { action: 'none' })
  assert.deepEqual(classifyExternalScheme(42), { action: 'none' })
  assert.deepEqual(classifyExternalScheme('not a url'), { action: 'none' })
  assert.deepEqual(classifyExternalScheme('C:/Windows/system32'), { action: 'none' }) // drive-letter protocol
  assert.deepEqual(classifyExternalScheme(`mailto:a@b.test${'x'.repeat(5000)}`), { action: 'none' })
  // argv-shaping and control bytes never reach openExternal.
  assert.deepEqual(classifyExternalScheme('spotify:track:1" --flag'), { action: 'none' })
  assert.deepEqual(classifyExternalScheme('mailto:a@b.test\\x0a'), { action: 'none' })
  assert.deepEqual(classifyExternalScheme('figma://file/ab\tc'), { action: 'none' })
})

test('case and whitespace variants of a real scheme still hand off', () => {
  assert.equal(classifyExternalScheme('FIGMA://FILE/x').app, 'figma')
  assert.equal(classifyExternalScheme('MailTo:a@b.test').app, 'mail')
})
