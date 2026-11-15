// node --test suite for the §B.8.4 session partition policy (pure):
// field normalization, sandbox resolution, region-persist partitions,
// privacy precedence, hostile-value rejection.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  SANDBOX_PARTITION,
  normalizePartitionField,
  isSandboxPartition,
  resolveTabPartition,
} = require('../src/main/spatial/session-partitions.js')

test('sandbox resolves to the non-persistent temp:sandbox partition', () => {
  assert.deepEqual(resolveTabPartition('sandbox'), { partition: SANDBOX_PARTITION, persistent: false })
  assert.equal(SANDBOX_PARTITION, 'temp:sandbox')
  assert.equal(isSandboxPartition('sandbox'), true)
})

test('default/absent fields resolve null → the profile session path', () => {
  assert.equal(resolveTabPartition('default'), null)
  assert.equal(resolveTabPartition(null), null)
  assert.equal(resolveTabPartition(undefined), null)
  assert.equal(normalizePartitionField('default'), 'default')
})

test('persist:region-<id> resolves as a persistent partition', () => {
  const decision = resolveTabPartition('persist:region-ab12cd34')
  assert.deepEqual(decision, { partition: 'persist:region-ab12cd34', persistent: true })
  assert.equal(normalizePartitionField('persist:region-9'), 'persist:region-9')
})

test('a private tab never shares the sandbox session', () => {
  assert.equal(resolveTabPartition('sandbox', { private: true }), null)
  assert.equal(resolveTabPartition('persist:region-x', { private: true }), null)
})

test('hostile and unknown values drop to null, never select another partition', () => {
  for (const bad of [
    'persist:chrome', // another surface's partition namespace
    'persist:chromium',
    'persist:region', // missing id
    'persist:region-', // empty id
    'persist:region-A'.repeat(3), // overlong
    'persist:region-../escape',
    'persist:region-a;b',
    'persist:region-a/b',
    'persist:region-a:b',
    'persist:region-a b',
    'temp:sandbox', // raw partition string is NOT a field value
    'region-abc',
    '',
    42,
    {},
    true,
  ]) {
    assert.equal(normalizePartitionField(bad), null, String(bad))
    assert.equal(resolveTabPartition(bad), null, String(bad))
    assert.equal(isSandboxPartition(bad), false)
  }
})

test('sandbox flag reads through the normalizer even on odd casing', () => {
  assert.equal(isSandboxPartition('Sandbox'), true)
  assert.equal(normalizePartitionField('PERSIST:REGION-CAP-9'), 'persist:region-cap-9')
})
