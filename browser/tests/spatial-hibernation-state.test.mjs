// node --test suite for the true 0 MB hibernation state (Phase 3, step 2 —
// no Electron): the collector/restorer scripts are executable strings, the
// normalization is hostile-payload-proof, and the 2.5 s audio debounce holds.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  AUDIO_DEBOUNCE_MS,
  MAX_EXCERPT_CHARS,
  collectHibernationScript,
  normalizeHibernationState,
  restoreHibernationScript,
  nextAudioImmunity,
  isAudioImmune,
} = require('../src/main/spatial/hibernation-state.js')

test('the collector script runs and degrades to null outside a page (catch-all)', () => {
  const script = collectHibernationScript()
  assert.equal(typeof script, 'string')
  assert.ok(script.length > 0)
  // In a bare Node context there is no `document`; the script must catch and
  // return null rather than throw into executeJavaScript.
  const outcome = eval(script)
  assert.equal(outcome, null)
})

test('normalizeHibernationState keeps the spec tuple and clamps magnitudes', () => {
  const state = normalizeHibernationState({ scrollX: 12.4, scrollY: -3, mediaTime: 41.9999, excerpt: '  hello   world  ' })
  assert.equal(state.scrollX, 12)
  assert.equal(state.scrollY, -3)
  assert.equal(state.mediaTime, 42)
  assert.equal(state.excerpt, 'hello world')
  assert.equal(Number.isFinite(state.at), true)
  // Absurd scroll magnitudes clamp to the graph's coordinate bound.
  const clamped = normalizeHibernationState({ scrollX: 1e12, scrollY: -1e12, excerpt: 'x' })
  assert.equal(Math.abs(clamped.scrollX) <= 1_000_000, true)
  assert.equal(Math.abs(clamped.scrollY) <= 1_000_000, true)
})

test('normalizeHibernationState drops the excerpt for private (noCapture) nodes', () => {
  // Scroll survives (UI state), the excerpt never does (page content).
  const state = normalizeHibernationState({ scrollX: 0, scrollY: 900, excerpt: 'secret text' }, { private: true })
  assert.equal(state.excerpt, '')
  assert.equal(state.scrollY, 900)
  // A private page that offers nothing but text records nothing at all.
  assert.equal(normalizeHibernationState({ scrollX: 0, scrollY: 0, excerpt: 'secret text' }, { private: true }), null)
})

test('normalizeHibernationState returns null on hostile or empty answers', () => {
  assert.equal(normalizeHibernationState(null), null)
  assert.equal(normalizeHibernationState('junk'), null)
  assert.equal(normalizeHibernationState({}), null)
  assert.equal(normalizeHibernationState({ scrollX: Number.NaN, scrollY: '9', mediaTime: 'x', excerpt: 42 }), null)
  // A mediaTime beyond the sanity bound is dropped, not trusted — the rest
  // of the record still survives.
  assert.equal(normalizeHibernationState({ scrollY: 5, mediaTime: 1e9 }).mediaTime, null)
  assert.equal(normalizeHibernationState({ scrollY: 5, mediaTime: Number.NaN }).mediaTime, null)
  // The excerpt never exceeds its cap.
  const long = normalizeHibernationState({ excerpt: 'a'.repeat(5000) })
  assert.equal(long.excerpt.length, MAX_EXCERPT_CHARS)
})

test('the restorer script runs, never throws, and never force-plays media', () => {
  const script = restoreHibernationScript({ scrollX: 120, scrollY: 480, mediaTime: 33.5 })
  assert.equal(typeof script, 'string')
  // No `play()` call: a page wakes exactly as quiet as it slept.
  assert.ok(!script.includes('.play'))
  assert.ok(script.includes('currentTime'))
  // In a bare Node context there is no `window`; the script must catch and
  // return false rather than throw into executeJavaScript.
  assert.equal(eval(script), false)
})

test('nextAudioImmunity stamps the 2.5 s debounce window', () => {
  assert.equal(nextAudioImmunity(10_000), 10_000 + AUDIO_DEBOUNCE_MS)
  assert.equal(AUDIO_DEBOUNCE_MS, 2500)
  assert.equal(nextAudioImmunity(10_000, { debounceMs: 0 }), 10_000)
  // A junk clock falls back to Date.now(): the stamp is still a real deadline.
  const stamped = nextAudioImmunity(Number.NaN)
  assert.equal(Number.isFinite(stamped), true)
  assert.ok(stamped >= AUDIO_DEBOUNCE_MS)
})

test('isAudioImmune covers the audible flag and the brief-pause window', () => {
  const now = 1_000_000
  // Actually audible: immune outright.
  assert.equal(isAudioImmune({ audible: true, audioImmuneUntil: 0 }, now), true)
  // Paused but inside the debounce window: immune (the spec's brief pause).
  assert.equal(isAudioImmune({ audible: false, audioImmuneUntil: now + 1 }, now), true)
  // Window expired: evictable again.
  assert.equal(isAudioImmune({ audible: false, audioImmuneUntil: now - 1 }, now), false)
  // No record at all: evictable.
  assert.equal(isAudioImmune({ audible: false }, now), false)
  assert.equal(isAudioImmune(null, now), false)
  // The full loop: a pause that recovers inside 2.5 s never loses immunity.
  const until = nextAudioImmunity(now)
  assert.equal(isAudioImmune({ audible: false, audioImmuneUntil: until }, now + AUDIO_DEBOUNCE_MS - 1), true)
  assert.equal(isAudioImmune({ audible: false, audioImmuneUntil: until }, now + AUDIO_DEBOUNCE_MS + 1), false)
})
