// node --test suite for the pure link-branching policy (Phase 3, step 3 —
// no Electron): classification, chain collapse, child positioning.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  REDIRECT_COLLAPSE_MS,
  classifyChildBranch,
  shouldCollapseBranch,
  childBranchPosition,
  appendSubPage,
  looksLikeAuthOrPaymentUrl,
} = require('../src/main/spatial/branch-policy.js')

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

test('ordinary user link branches fork a fresh child node', () => {
  // Cmd/Ctrl+Click, middle-click and target="_blank" all arrive as
  // foreground/background-tab dispositions of an http(s) target.
  assert.equal(classifyChildBranch({ url: 'https://example.test/docs', disposition: 'foreground-tab' }), 'fork')
  assert.equal(classifyChildBranch({ url: 'https://example.test/docs', disposition: 'background-tab' }), 'fork')
  assert.equal(classifyChildBranch({ url: 'http://example.test/', disposition: '' }), 'fork')
})

test('POST bodies and non-navigable targets are refused, never forked', () => {
  assert.equal(classifyChildBranch({ url: 'https://example.test/submit', postBody: { data: 'x' } }), 'refuse')
  assert.equal(classifyChildBranch({ url: 'about:blank', disposition: 'foreground-tab' }), 'refuse')
  assert.equal(classifyChildBranch({ url: 'blanc://settings/', disposition: 'foreground-tab' }), 'refuse')
  assert.equal(classifyChildBranch({ url: '', disposition: 'foreground-tab' }), 'refuse')
  assert.equal(classifyChildBranch(null), 'refuse')
})

test('OAuth/SSO/payment popups collapse into a via-auth node, not a node per hop', () => {
  assert.equal(classifyChildBranch({ url: 'https://accounts.google.com/o/oauth2/auth?x=1', disposition: 'foreground-tab' }), 'via-auth')
  assert.equal(classifyChildBranch({ url: 'https://checkout.stripe.com/c/pay/x', disposition: 'background-tab' }), 'via-auth')
  assert.equal(classifyChildBranch({ url: 'https://example.test/signin', disposition: 'foreground-tab' }), 'via-auth')
  // A featureful popup keeps its real window (opener must survive), but the
  // classification stays via-auth for the record.
  assert.equal(classifyChildBranch({ url: 'https://example.test/', disposition: 'new-window' }), 'via-auth')
})

test('shouldCollapseBranch only folds recent via-auth hops of the same provider', () => {
  const prev = { url: 'https://accounts.google.com/o/oauth2/auth', viaAuth: true, createdAt: 1000 }
  assert.equal(shouldCollapseBranch(prev, { url: 'https://myaccount.google.com/next', at: 1000 + REDIRECT_COLLAPSE_MS - 1 }), true)
  assert.equal(shouldCollapseBranch(prev, { url: 'https://myaccount.google.com/next', at: 1000 + REDIRECT_COLLAPSE_MS + 1 }), false)
  // Cross-provider hops are separate flows.
  assert.equal(shouldCollapseBranch(prev, { url: 'https://login.microsoftonline.com/x', at: 1500 }), false)
  // An ordinary fork child never absorbs a hop.
  assert.equal(shouldCollapseBranch({ ...prev, viaAuth: false }, { url: 'https://myaccount.google.com/next', at: 1500 }), false)
  // Different protocols never collapse.
  assert.equal(shouldCollapseBranch(prev, { url: 'http://accounts.google.com/x', at: 1500 }), false)
})

test('childBranchPosition chains right of the parent, alternating rows', () => {
  const parent = { x: 100, y: 200 }
  const first = childBranchPosition(parent, 0)
  const second = childBranchPosition(parent, 1)
  assert.deepEqual(first, { x: 100 + 384, y: 200 + 64 })
  assert.deepEqual(second, { x: 100 + 384 * 2, y: 200 - 64 })
  // Junk parent geometry lands at the origin, never NaN.
  assert.deepEqual(childBranchPosition(null, 0), { x: 384, y: 64 })
  assert.deepEqual(childBranchPosition({ x: Number.NaN, y: 3 }, 0), { x: 384, y: 67 })
})

test('appendSubPage records same-document hops, dedupes and caps the strip', () => {
  const a = 'https://example.test/a'
  const b = 'https://example.test/b'
  let strip = appendSubPage([], a, 1)
  assert.deepEqual(strip, [{ url: a, at: 1 }])
  strip = appendSubPage(strip, a, 2) // consecutive repeat → unchanged
  assert.deepEqual(strip, [{ url: a, at: 1 }])
  strip = appendSubPage(strip, b, 3)
  assert.deepEqual(strip, [{ url: a, at: 1 }, { url: b, at: 3 }])
  // Cap: the oldest entries drop first, input never mutates.
  let grown = []
  for (let i = 0; i < 40; i += 1) grown = appendSubPage(grown, `https://example.test/p${i}`, i)
  assert.equal(grown.length, 32)
  assert.equal(grown[0].url, 'https://example.test/p8')
  assert.equal(appendSubPage('junk', a, 1).length, 1)
})

test('looksLikeAuthOrPaymentUrl is conservative: known hosts or auth-shaped paths', () => {
  assert.equal(looksLikeAuthOrPaymentUrl('https://github.com/login/oauth/authorize'), true)
  assert.equal(looksLikeAuthOrPaymentUrl('https://pay.google.com/x'), true)
  assert.equal(looksLikeAuthOrPaymentUrl('https://shop.example.test/checkout'), true)
  assert.equal(looksLikeAuthOrPaymentUrl('https://example.test/docs'), false)
  assert.equal(looksLikeAuthOrPaymentUrl('not a url'), false)
  assert.equal(looksLikeAuthOrPaymentUrl(null), false)
})
