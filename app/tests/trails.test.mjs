// §B.7 Path-Preserving Trails unit tests — pure module (app/src/lib/trails.ts),
// no React/Electron/store. Covers the three Phase 3.4 pure parts:
//   1. provenance capture shape (anchor text/alt, ≤140 surrounding sentence,
//      scroll offset);
//   2. the cross-domain in-place navigation guard decision (same vs cross);
//   3. the Trace-Rabbit-Hole chain-walk collector (upstream to root +
//      downstream closure, cycle-safe).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ANCHOR_TEXT_MAX,
  CONTEXT_SNIPPET_MAX,
  SUB_PAGES_NAV_CAP,
  captureAnchorProvenance,
  collectTrailChain,
  decideInPlaceNavigation,
} from '../src/lib/trails.ts'

/* ------------------------------------------------------------------ */
/* 1 — provenance capture shape                                        */
/* ------------------------------------------------------------------ */

test('provenance capture keeps the exact anchor text and clamps the snippet to 140', () => {
  const longSentence =
    'The Klim Söhne specimen page opens with a long editorial paragraph that keeps going and going past any ' +
    'reasonable reading width, eventually exceeding one hundred and forty characters by a comfortable margin ' +
    'so the cap has something real to bite on.'
  assert.ok(longSentence.length > 140)
  const provenance = captureAnchorProvenance({
    anchorText: 'Klim Söhne specimen',
    contextText: longSentence,
    scrollY: 420,
  })
  assert.ok(provenance, 'provenance captured')
  assert.equal(provenance.anchorText, 'Klim Söhne specimen')
  assert.ok(provenance.contextSnippet && provenance.contextSnippet.length <= 140)
  assert.equal(provenance.scrollYAtSpawn, 420)
})

test('provenance capture narrows the context to the sentence containing the anchor', () => {
  const paragraph =
    'First sentence about typography history. The Klim Söhne specimen deserves your attention today. Third sentence unrelated.'
  const provenance = captureAnchorProvenance({
    anchorText: 'Klim Söhne specimen',
    contextText: paragraph,
    scrollY: 0,
  })
  assert.ok(provenance?.contextSnippet)
  assert.ok(provenance.contextSnippet.includes('Klim Söhne specimen'))
  assert.ok(!provenance.contextSnippet.includes('First sentence'))
  assert.ok(!provenance.contextSnippet.includes('Third sentence'))
})

test('provenance capture falls back to the image alt when the anchor is textless', () => {
  const provenance = captureAnchorProvenance({
    anchorText: '',
    altText: 'Studio photograph',
    contextText: 'A gallery of   whitespace-collapsed   text.\nWith line breaks.',
    scrollY: 12.6,
  })
  assert.equal(provenance?.anchorText, 'Studio photograph')
  assert.equal(provenance?.contextSnippet, 'A gallery of whitespace-collapsed text. With line breaks.')
  assert.equal(provenance?.scrollYAtSpawn, 13, 'scroll rounds to whole px and never goes negative')
})

test('provenance capture clamps a runaway anchor to a word boundary', () => {
  const runaway = 'word '.repeat(40).trim()
  assert.ok(runaway.length > ANCHOR_TEXT_MAX)
  const provenance = captureAnchorProvenance({ anchorText: runaway, scrollY: 0 })
  assert.ok(provenance?.anchorText)
  assert.ok(provenance.anchorText.length <= ANCHOR_TEXT_MAX)
  assert.ok(!provenance.anchorText.endsWith('word'.slice(0, 1)), 'no partial word tail')
  assert.ok(provenance.anchorText.endsWith('word') || provenance.anchorText.length === ANCHOR_TEXT_MAX - 1)
})

test('provenance capture is null when nothing was observed', () => {
  assert.equal(captureAnchorProvenance(null), null)
  assert.equal(captureAnchorProvenance(undefined), null)
  assert.equal(captureAnchorProvenance({ anchorText: '   ', contextText: '', scrollY: null }), null)
  assert.equal(captureAnchorProvenance({ scrollY: Number.NaN }), null)
  const scrollOnly = captureAnchorProvenance({ scrollY: -50 })
  assert.deepEqual(scrollOnly, { anchorText: null, contextSnippet: null, scrollYAtSpawn: 0 })
})

/* ------------------------------------------------------------------ */
/* 2 — cross-domain in-place navigation guard decision                 */
/* ------------------------------------------------------------------ */

test('same-domain navigation decides filmstrip (same domain)', () => {
  const decision = decideInPlaceNavigation('example.com', 'https://example.com/article/2')
  assert.equal(decision.kind, 'same-domain')
  assert.equal(decision.domain, 'example.com')
})

test('same-domain decision survives the www prefix on either side', () => {
  const decision = decideInPlaceNavigation('example.com', 'https://www.example.com/article/2')
  assert.equal(decision.kind, 'same-domain')
  const reverse = decideInPlaceNavigation('www.example.com', 'https://example.com/x')
  assert.equal(reverse.kind, 'same-domain')
})

test('cross-domain navigation decides freeze-then-spawn (never silent overwrite)', () => {
  const decision = decideInPlaceNavigation('example.com', 'https://figma.com/file/abc')
  assert.equal(decision.kind, 'cross-domain')
  assert.equal(decision.fromDomain, 'example.com')
  assert.equal(decision.toDomain, 'figma.com')
})

test('the filmstrip cap constant is 20 for the navigation path', () => {
  assert.equal(SUB_PAGES_NAV_CAP, 20)
})

test('a non-URL target still yields a cross-domain decision', () => {
  const decision = decideInPlaceNavigation('example.com', 'not a url at all')
  assert.equal(decision.kind, 'cross-domain')
})

/* ------------------------------------------------------------------ */
/* 3 — Trace Rabbit Hole chain walk                                    */
/* ------------------------------------------------------------------ */

let seq = 0
function node(overrides = {}) {
  seq += 1
  return {
    uuid: overrides.uuid ?? `n${seq}`,
    urlHash: `h${seq}`,
    url: 'https://example.com/',
    domain: 'example.com',
    title: `Node ${seq}`,
    nodeType: 'tab',
    parentUuid: null,
    ...overrides,
  }
}
function edge(source, target, kind = 'spawn') {
  return { id: `${source}->${target}`, source, target, weight: 1, kind, createdAt: 0 }
}
function recordNodes(list) {
  const record = {}
  for (const entry of list) record[entry.uuid] = entry
  return record
}
function recordEdges(list) {
  const record = {}
  for (const entry of list) record[entry.id] = entry
  return record
}

test('chain walk climbs parentUuid upstream to the root and closes downstream descendants', () => {
  // root → a → b → c (spawn lineage), plus b → d and d → e.
  const root = node({ uuid: 'root' })
  const a = node({ uuid: 'a', parentUuid: 'root' })
  const b = node({ uuid: 'b', parentUuid: 'a' })
  const c = node({ uuid: 'c', parentUuid: 'b' })
  const d = node({ uuid: 'd', parentUuid: 'b' })
  const e = node({ uuid: 'e', parentUuid: 'd' })
  const unrelated = node({ uuid: 'unrelated' })
  const nodes = recordNodes([root, a, b, c, d, e, unrelated])
  const edges = recordEdges([
    edge('root', 'a'),
    edge('a', 'b'),
    edge('b', 'c'),
    edge('b', 'd'),
    edge('d', 'e'),
  ])

  const chain = collectTrailChain('c', nodes, edges)
  // Upstream: c → b → a → root. Downstream of c: nothing.
  assert.deepEqual(
    [...chain].sort(),
    ['a', 'b', 'c', 'root'],
  )
  assert.ok(!chain.has('d'), 'siblings are not downstream of the trace origin')
  assert.ok(!chain.has('unrelated'))

  // Tracing from the middle walks BOTH directions.
  const fromB = collectTrailChain('b', nodes, edges)
  assert.deepEqual([...fromB].sort(), ['a', 'b', 'c', 'd', 'e', 'root'])
})

test('chain walk adopts incoming spawn/visit edges upstream', () => {
  const root = node({ uuid: 'root' })
  const target = node({ uuid: 'target' })
  const nodes = recordNodes([root, target])
  const edges = recordEdges([
    edge('root', 'target', 'visit'), // co-visitation adoptive lineage
  ])
  const chain = collectTrailChain('target', nodes, edges)
  assert.deepEqual([...chain].sort(), ['root', 'target'])
})

test('chain walk closes downstream through visit edges too', () => {
  const a = node({ uuid: 'a' })
  const b = node({ uuid: 'b' })
  const nodes = recordNodes([a, b])
  const edges = recordEdges([edge('a', 'b', 'visit')])
  const chain = collectTrailChain('a', nodes, edges)
  assert.deepEqual([...chain].sort(), ['a', 'b'])
})

test('chain walk never joins ghost edges', () => {
  const a = node({ uuid: 'a' })
  const b = node({ uuid: 'b' })
  const nodes = recordNodes([a, b])
  const edges = recordEdges([edge('a', 'b', 'ghost')])
  assert.deepEqual([...collectTrailChain('a', nodes, edges)], ['a'])
})

test('chain walk is cycle-safe on pathological graphs', () => {
  // a → b → c → a (a self-referential descendant loop) plus a dangling
  // parentUuid that points back down the chain.
  const a = node({ uuid: 'a', parentUuid: 'c' })
  const b = node({ uuid: 'b', parentUuid: 'a' })
  const c = node({ uuid: 'c', parentUuid: 'b' })
  const nodes = recordNodes([a, b, c])
  const edges = recordEdges([edge('a', 'b'), edge('b', 'c'), edge('c', 'a')])
  const chain = collectTrailChain('a', nodes, edges)
  assert.ok(chain.size <= 3, `terminated with ${chain.size} nodes`)
  assert.ok(chain.has('a') && chain.has('b') && chain.has('c'))
})

test('chain walk returns empty for an unknown uuid', () => {
  const nodes = recordNodes([node({ uuid: 'a' })])
  assert.deepEqual([...collectTrailChain('ghost-uuid', nodes, {})], [])
})
