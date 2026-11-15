/**
 * gen_golden.mjs — generates golden JSON for the moodboard Rust port by
 * running the ORIGINAL TypeScript solver (app/src/lib/moodboard.ts) through
 * Node's type stripping. The Rust test (tests/golden_moodboard.rs) asserts
 * bit-for-bit equality against this output.
 *
 * Run:  node scripts/gen_golden.mjs   (from crates/spatial-core)
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

// Import the real TS module (Node ≥23.6 strips types for .ts automatically).
const tsSource = join(dirname(fileURLToPath(import.meta.url)), '../../../app/src/lib/moodboard.ts')
const moodboard = await import(pathToFileURL(tsSource).href)

const scenarios = [
  { name: 'empty', nodes: [], options: {} },
  {
    name: 'single',
    nodes: [{ uuid: 'a', x: 100, y: 80, isPinned: false }],
    options: {},
  },
  {
    name: 'five-plus-pinned',
    nodes: [
      { uuid: 'p1', x: 0, y: 0, isPinned: true },
      { uuid: 'c1', x: 300, y: 500, isPinned: false },
      { uuid: 'c2', x: 600, y: 120, isPinned: false },
      { uuid: 'c3', x: 120, y: 80, isPinned: false },
      { uuid: 'c4', x: 900, y: 400, isPinned: false },
      { uuid: 'c5', x: 40, y: 30, isPinned: false },
    ],
    options: {},
  },
  {
    name: 'twelve-grid',
    nodes: Array.from({ length: 12 }, (_, i) => ({
      uuid: `n${i}`,
      x: ((i % 4) * 400) + i * 3,
      y: Math.floor(i / 4) * 300,
      isPinned: false,
    })),
    options: {},
  },
  {
    name: 'max-columns-2',
    nodes: Array.from({ length: 7 }, (_, i) => ({ uuid: `n${i}`, x: i * 310, y: i * 240, isPinned: false })),
    options: { maxColumns: 2 },
  },
  {
    name: 'keep-out-flow',
    nodes: [
      { uuid: 'blocker', x: 100, y: 100, isPinned: true },
      { uuid: 'a', x: 10, y: 10, isPinned: false },
      { uuid: 'b', x: 20, y: 20, isPinned: false },
      { uuid: 'c', x: 30, y: 30, isPinned: false },
    ],
    options: {},
  },
  {
    name: 'pins-far-apart',
    nodes: [
      { uuid: 'pin-a', x: 0, y: 0, isPinned: true },
      { uuid: 'pin-b', x: 1600, y: 0, isPinned: true },
      { uuid: 'c1', x: 300, y: 500, isPinned: false },
      { uuid: 'c2', x: 600, y: 800, isPinned: false },
      { uuid: 'c3', x: 900, y: 100, isPinned: false },
      { uuid: 'c4', x: 1300, y: 600, isPinned: false },
    ],
    options: {},
  },
  {
    name: 'negative-coords-dup-tiebreak',
    nodes: [
      { uuid: 'n2', x: -400, y: -200, isPinned: false },
      { uuid: 'n10', x: -400, y: -200, isPinned: false },
      { uuid: 'n1', x: -350, y: -200, isPinned: false },
      { uuid: 'zz', x: 0, y: 500, isPinned: false },
      { uuid: 'aa', x: 0, y: 500, isPinned: false },
    ],
    options: {},
  },
  {
    name: 'all-pinned',
    nodes: [
      { uuid: 'a', x: 10, y: 20, isPinned: true },
      { uuid: 'b', x: 300, y: 40, isPinned: true },
    ],
    options: {},
  },
  {
    name: 'custom-card-and-margin',
    nodes: [
      { uuid: 'pin', x: 50, y: 50, isPinned: true },
      { uuid: 'a', x: 0, y: 0, isPinned: false },
      { uuid: 'b', x: 10, y: 10, isPinned: false },
      { uuid: 'c', x: 20, y: 20, isPinned: false },
    ],
    options: { cardWidth: 100, cardHeight: 60, pitchAspect: 2, pitchPaddingY: 40, overlapMargin: 0 },
  },
  {
    name: 'overlap-margin-48',
    nodes: [
      { uuid: 'blocker', x: 0, y: 0, isPinned: true },
      { uuid: 'a', x: 500, y: 500, isPinned: false },
      { uuid: 'b', x: 510, y: 510, isPinned: false },
    ],
    options: { overlapMargin: 48 },
  },
  {
    name: 'fractal-scatter',
    nodes: Array.from({ length: 25 }, (_, i) => ({
      uuid: `u${25 - i}`,
      x: ((i * 37) % 2000) - 500,
      y: ((i * 53) % 1500) - 300,
      isPinned: i % 5 === 0,
    })),
    options: {},
  },
]

const golden = []
for (const scenario of scenarios) {
  const result = moodboard.computeMoodboardGrid(scenario.nodes, scenario.options)
  golden.push({ name: scenario.name, nodes: scenario.nodes, options: scenario.options, expected: result })
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '../tests/golden')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'moodboard_golden.json'), JSON.stringify(golden, null, 1) + '\n')
console.log(`wrote ${golden.length} scenarios to tests/golden/moodboard_golden.json`)

// Also dump a few scalar sanity values from the TS module.
const constants = {
  cardWidth: moodboard.MOODBOARD_CARD_WIDTH,
  cardHeight: moodboard.MOODBOARD_CARD_HEIGHT,
  pitchAspect: moodboard.MOODBOARD_PITCH_ASPECT,
  pitchPaddingY: moodboard.MOODBOARD_PITCH_PADDING_Y,
  pitchHeight: moodboard.MOODBOARD_PITCH_HEIGHT,
  pitchWidth: moodboard.MOODBOARD_PITCH_WIDTH,
  slotInsetX: moodboard.MOODBOARD_SLOT_INSET_X,
  slotInsetY: moodboard.MOODBOARD_SLOT_INSET_Y,
  overlapMargin: moodboard.MOODBOARD_OVERLAP_MARGIN,
}
writeFileSync(join(outDir, 'constants.json'), JSON.stringify(constants, null, 1) + '\n')
console.log('constants:', JSON.stringify(constants))
