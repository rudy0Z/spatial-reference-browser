// Moodboard contact-sheet solver tests — pure module, deterministic math.
// Pins the canonical Phase 1.5 numbers the master spec cites.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computeMoodboardGrid,
  MOODBOARD_CARD_WIDTH,
  MOODBOARD_CARD_HEIGHT,
  MOODBOARD_PITCH_WIDTH,
  MOODBOARD_PITCH_HEIGHT,
  MOODBOARD_SLOT_INSET_X,
  MOODBOARD_SLOT_INSET_Y,
  MOODBOARD_OVERLAP_MARGIN,
} from '../src/lib/moodboard.ts'

function scattered(count, originX = 0, originY = 0) {
  const out = []
  for (let i = 0; i < count; i++) {
    out.push({ uuid: `n${i}`, x: originX + ((i * 97) % 700), y: originY + ((i * 211) % 900), isPinned: false })
  }
  return out
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

test('canonical Phase 1.5 pitch numbers are pinned', () => {
  assert.equal(MOODBOARD_CARD_WIDTH, 260)
  assert.equal(MOODBOARD_CARD_HEIGHT, 199)
  assert.equal(MOODBOARD_PITCH_WIDTH, 384)
  assert.equal(MOODBOARD_PITCH_HEIGHT, 240)
  assert.equal(MOODBOARD_SLOT_INSET_X, 62)
  assert.equal(MOODBOARD_SLOT_INSET_Y, 20.5)
  assert.equal(MOODBOARD_OVERLAP_MARGIN, 12)
})

test('solver is deterministic: same input, identical output', () => {
  const nodes = scattered(12)
  const a = computeMoodboardGrid(nodes)
  const b = computeMoodboardGrid(nodes)
  assert.deepEqual(a, b)
})

test('placed cards never overlap (16:10 contact sheet)', () => {
  const nodes = scattered(9)
  const result = computeMoodboardGrid(nodes)
  assert.equal(result.placedCount, 9)
  const placed = Object.entries(result.positions).map(([uuid, p]) => ({
    uuid,
    x: p.x,
    y: p.y,
    width: result.cardWidth,
    height: result.cardHeight,
  }))
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      assert.equal(
        rectsOverlap(placed[i], placed[j]),
        false,
        `${placed[i].uuid} overlaps ${placed[j].uuid}`,
      )
    }
  }
})

test('pinned anchors keep their exact coordinates and never appear in moved', () => {
  const pin = { uuid: 'pin', x: 500, y: 320, isPinned: true }
  const nodes = [pin, ...scattered(5)]
  const result = computeMoodboardGrid(nodes)
  assert.deepEqual(result.positions.pin, { x: 500, y: 320 })
  assert.equal(result.moved.includes('pin'), false)
  assert.equal(result.placedCount, 5)
})

test('placed slots reject the pinned footprint grown by the keep-out margin', () => {
  const pin = { uuid: 'pin', x: 0, y: 0, isPinned: true }
  const nodes = [pin, ...scattered(8)]
  const result = computeMoodboardGrid(nodes)
  const pinFootprint = {
    x: pin.x - MOODBOARD_OVERLAP_MARGIN,
    y: pin.y - MOODBOARD_OVERLAP_MARGIN,
    width: result.cardWidth + MOODBOARD_OVERLAP_MARGIN * 2,
    height: result.cardHeight + MOODBOARD_OVERLAP_MARGIN * 2,
  }
  for (const [uuid, p] of Object.entries(result.positions)) {
    if (uuid === 'pin') continue
    const slot = { x: p.x, y: p.y, width: result.cardWidth, height: result.cardHeight }
    assert.equal(
      rectsOverlap(slot, pinFootprint),
      false,
      `${uuid} was placed inside the pinned keep-out zone`,
    )
  }
})

test('empty selection yields an empty sheet', () => {
  const result = computeMoodboardGrid([])
  assert.equal(result.columns, 0)
  assert.equal(result.placedCount, 0)
  assert.deepEqual(result.moved, [])
})
