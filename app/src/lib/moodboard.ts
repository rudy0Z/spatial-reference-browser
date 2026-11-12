/**
 * app/src/lib/moodboard.ts — deterministic "Tidy to Moodboard Grid" math.
 *
 * PURE MODULE — no React, no Electron, no store, no Date.now/Math.random,
 * no imports at all. Runs identically in the browser, in a node unit test
 * (`node --test` / type-stripping) and later inside the Rust-core wrapper
 * (Phase 2 ports the same contract), so every consumer can pin exact numbers.
 *
 * Contract (ZCODE_MASTER_PROMPT.md §Phase 1.5):
 *   "snap that region's cards into a crisp non-overlapping contact-sheet grid
 *    (columns fitted to count, uniform 16:10 card pitch) while preserving ALL
 *    graph edges and pinned anchors exactly."
 *
 *  - The grid is expressed as POSITIONS ONLY. Graph edges are records keyed
 *    by node uuid, so a position-only tidy preserves the full edge topology
 *    by construction — the caller (store action `tidyToMoodboard`) writes the
 *    returned positions and never touches edges.
 *  - Pinned anchors (`isPinned`) keep their EXACT input position — the solver
 *    never emits a moved slot for them, and every grid slot is rejected if it
 *    would overlap a pinned anchor's card footprint (plus a small clearance),
 *    so the sheet flows around anchors instead of through them.
 *  - Columns are fitted to the count: `ceil(sqrt(n))` (capped by
 *    `maxColumns`), giving the classic near-square contact sheet.
 *  - The pitch cell is EXACTLY 16:10 (width:height): the Phase 1.5 reference
 *    card is 260px wide with a 16:10 edge-to-edge preview (≈163px) plus a
 *    36px footer ≈ 199px tall; the pitch adds 41px of vertical breathing room
 *    (sticky-note/deck overhangs) → 240px, and 240 × 16/10 = 384px. Cards are
 *    centered inside their pitch cell.
 *  - Cards are ordered into slots in stable reading order of the current
 *    scatter (top → bottom, left → right, uuid tiebreak) — deterministic per
 *    node set, never random, never per-render.
 *  - The sheet origin anchors on a bounding-box center of card centers, so
 *    the sheet lands where the region lives instead of teleporting — and the
 *    solver is IDEMPOTENT (tidying an already-tidied region moves nothing):
 *      · no pinned anchors  → anchor = bbox center of all card centers;
 *        the placed lattice's own bbox center reproduces the anchor exactly.
 *      · pinned anchors     → anchor = bbox center of the PINNED cards'
 *        centers: the anchors are the immovable geography, the sheet
 *        organizes around them, and a second run reads the identical anchor.
 */

/** A node's slot is its card's TOP-LEFT corner — the same coordinates the
 * spatial store persists and React Flow renders. */
export type MoodboardPoint = { x: number; y: number }

export type MoodboardNodeInput = {
  uuid: string
  /** Persisted top-left position. */
  x: number
  y: number
  /** Pinned anchors are preserved exactly and excluded from the sheet. */
  isPinned: boolean
}

export type MoodboardRect = { x: number; y: number; width: number; height: number }

export type MoodboardGridOptions = {
  /** Reference card width. Default 260 (Phase 1.5 card shell). */
  cardWidth?: number
  /** Reference card height. Default 199 (16:10 preview ≈163 + 36 footer). */
  cardHeight?: number
  /** Pitch cell aspect (width / height). Default 16/10. */
  pitchAspect?: number
  /** Vertical breathing room added to the card height to form the pitch.
   * Default 41 — clears sticky-note and deck overhangs. */
  pitchPaddingY?: number
  /** Hard cap on columns (1..). Default: uncapped. */
  maxColumns?: number
  /** Clearance grown around pinned footprints when rejecting slots. Default 12. */
  overlapMargin?: number
}

export type MoodboardGridResult = {
  /**
   * uuid → next top-left position for EVERY input node. Pinned anchors map to
   * their exact input coordinates; every other node maps to a sheet slot.
   */
  positions: Record<string, MoodboardPoint>
  /** Uuids whose computed slot differs from their input position (i.e. what
   * the store actually needs to write). Pinned anchors never appear here. */
  moved: string[]
  /** Uuids the solver could not place (only possible if the defensive row
   * guard trips — mathematically unreachable; consumers must leave these
   * nodes where they are). */
  unplaced: string[]
  /** Fitted column count (0 when there was nothing to place). */
  columns: number
  /** Rows actually used by placed cards. */
  rows: number
  /** Uniform pitch cell size — width:height is exactly `pitchAspect`. */
  pitchWidth: number
  pitchHeight: number
  /** The card footprint assumed for slots and pinned-overlap tests. */
  cardWidth: number
  cardHeight: number
  /** Top-left of the sheet's first pitch cell (world coordinates). */
  origin: MoodboardPoint
  /** Number of cards moved onto the sheet. */
  placedCount: number
}

/* ------------------------------------------------------------------ */
/* Canonical Phase 1.5 numbers (exported so tests + the store pin them) */
/* ------------------------------------------------------------------ */

/** Phase 1.5 reference card width (ZCODE_MASTER_PROMPT.md §Phase 1.5). */
export const MOODBOARD_CARD_WIDTH = 260
/** 16:10 edge-to-edge preview (162.5) + clean 36px footer, rounded. */
export const MOODBOARD_CARD_HEIGHT = 199
/** Uniform pitch cell aspect — width:height = 16:10. */
export const MOODBOARD_PITCH_ASPECT = 16 / 10
/** Vertical breathing room: card height + this = pitch height. */
export const MOODBOARD_PITCH_PADDING_Y = 41
/** 199 + 41 = 240. */
export const MOODBOARD_PITCH_HEIGHT = MOODBOARD_CARD_HEIGHT + MOODBOARD_PITCH_PADDING_Y
/** 240 × 16/10 = 384 — the pitch is exactly 16:10. */
export const MOODBOARD_PITCH_WIDTH = MOODBOARD_PITCH_HEIGHT * MOODBOARD_PITCH_ASPECT
/** Horizontal inset centering the 260px card inside the 384px pitch. */
export const MOODBOARD_SLOT_INSET_X = (MOODBOARD_PITCH_WIDTH - MOODBOARD_CARD_WIDTH) / 2
/** Vertical inset centering the 199px card inside the 240px pitch. */
export const MOODBOARD_SLOT_INSET_Y = (MOODBOARD_PITCH_HEIGHT - MOODBOARD_CARD_HEIGHT) / 2
/** Default clearance around pinned anchors when rejecting slots. */
export const MOODBOARD_OVERLAP_MARGIN = 12

/* ------------------------------------------------------------------ */
/* Solver                                                              */
/* ------------------------------------------------------------------ */

function rectIntersects(a: MoodboardRect, b: MoodboardRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/** Stable reading order over the current scatter: top → bottom, left → right, uuid tiebreak. */
function readingOrderCompare(a: MoodboardNodeInput, b: MoodboardNodeInput): number {
  if (a.y !== b.y) return a.y - b.y
  if (a.x !== b.x) return a.x - b.x
  if (a.uuid === b.uuid) return 0
  return a.uuid < b.uuid ? -1 : 1
}

/**
 * Compute the moodboard contact-sheet grid for a set of region nodes.
 *
 * Deterministic: same input → same output, always (stable sort comparators,
 * integer-ish pitch arithmetic, no clocks, no randomness). Pure: allocates
 * only its result, reads nothing but its arguments.
 */
export function computeMoodboardGrid(
  nodes: readonly MoodboardNodeInput[],
  options: MoodboardGridOptions = {},
): MoodboardGridResult {
  const cardWidth = options.cardWidth ?? MOODBOARD_CARD_WIDTH
  const cardHeight = options.cardHeight ?? MOODBOARD_CARD_HEIGHT
  const pitchAspect = options.pitchAspect ?? MOODBOARD_PITCH_ASPECT
  const pitchPaddingY = options.pitchPaddingY ?? MOODBOARD_PITCH_PADDING_Y
  const maxColumns = options.maxColumns ?? Number.POSITIVE_INFINITY
  const overlapMargin = options.overlapMargin ?? MOODBOARD_OVERLAP_MARGIN

  const pitchHeight = cardHeight + pitchPaddingY
  const pitchWidth = pitchHeight * pitchAspect
  const insetX = (pitchWidth - cardWidth) / 2
  const insetY = (pitchHeight - cardHeight) / 2

  const positions: Record<string, MoodboardPoint> = {}
  const moved: string[] = []
  const unplaced: string[] = []

  /* Pinned anchors keep their exact position; their card footprints (grown by
   * the clearance margin) become the keep-out rects the sheet flows around. */
  const pinnedRects: MoodboardRect[] = []
  const unpinned: MoodboardNodeInput[] = []
  let allMinX = Number.POSITIVE_INFINITY
  let allMinY = Number.POSITIVE_INFINITY
  let allMaxX = Number.NEGATIVE_INFINITY
  let allMaxY = Number.NEGATIVE_INFINITY
  let pinMinX = Number.POSITIVE_INFINITY
  let pinMinY = Number.POSITIVE_INFINITY
  let pinMaxX = Number.NEGATIVE_INFINITY
  let pinMaxY = Number.NEGATIVE_INFINITY
  let pinnedCount = 0
  for (const node of nodes) {
    const centerX = node.x + cardWidth / 2
    const centerY = node.y + cardHeight / 2
    allMinX = Math.min(allMinX, centerX)
    allMinY = Math.min(allMinY, centerY)
    allMaxX = Math.max(allMaxX, centerX)
    allMaxY = Math.max(allMaxY, centerY)
    if (node.isPinned) {
      pinnedCount += 1
      pinMinX = Math.min(pinMinX, centerX)
      pinMinY = Math.min(pinMinY, centerY)
      pinMaxX = Math.max(pinMaxX, centerX)
      pinMaxY = Math.max(pinMaxY, centerY)
      positions[node.uuid] = { x: node.x, y: node.y }
      pinnedRects.push({
        x: node.x - overlapMargin,
        y: node.y - overlapMargin,
        width: cardWidth + overlapMargin * 2,
        height: cardHeight + overlapMargin * 2,
      })
    } else {
      unpinned.push(node)
    }
  }
  const total = nodes.length
  /* Anchor rule (see header): pinned anchors dominate when present — the
   * immovable sheet geography; otherwise the whole region's card-center bbox. */
  const anchorX = pinnedCount > 0 ? (pinMinX + pinMaxX) / 2 : (allMinX + allMaxX) / 2
  const anchorY = pinnedCount > 0 ? (pinMinY + pinMaxY) / 2 : (allMinY + allMaxY) / 2
  const origin: MoodboardPoint = total > 0 ? { x: anchorX, y: anchorY } : { x: 0, y: 0 }

  if (unpinned.length === 0) {
    return {
      positions,
      moved,
      unplaced,
      columns: 0,
      rows: 0,
      pitchWidth,
      pitchHeight,
      cardWidth,
      cardHeight,
      origin,
      placedCount: 0,
    }
  }

  /* Columns fitted to the count: the classic near-square contact sheet. */
  const fitted = Math.ceil(Math.sqrt(unpinned.length))
  const columns = Math.max(1, Math.min(maxColumns, fitted))
  const estimatedRows = Math.ceil(unpinned.length / columns)

  /* The sheet lands where the region already lives: its center anchored on
   * the pinned anchors' card-center bbox (or the whole region's when unpinned). */
  origin.x -= (columns * pitchWidth) / 2
  origin.y -= (estimatedRows * pitchHeight) / 2

  const pending = [...unpinned].sort(readingOrderCompare)

  /* Each pinned footprint can block at most ~2 pitch rows vertically, so this
   * guard is mathematically unreachable — kept as a deterministic safety net
   * against unbounded loops instead of trusting the arithmetic blindly. */
  const maxRows = estimatedRows + pinnedRects.length * 2 + 16
  let placed = 0
  let rowsUsed = 0

  for (let row = 0; placed < pending.length && row < maxRows; row++) {
    rowsUsed = row + 1
    for (let col = 0; col < columns && placed < pending.length; col++) {
      const slot: MoodboardRect = {
        x: origin.x + col * pitchWidth + insetX,
        y: origin.y + row * pitchHeight + insetY,
        width: cardWidth,
        height: cardHeight,
      }
      const grown: MoodboardRect = {
        x: slot.x - overlapMargin,
        y: slot.y - overlapMargin,
        width: cardWidth + overlapMargin * 2,
        height: cardHeight + overlapMargin * 2,
      }
      let blocked = false
      for (const keepOut of pinnedRects) {
        if (rectIntersects(grown, keepOut)) {
          blocked = true
          break
        }
      }
      if (blocked) continue
      const node = pending[placed]
      const point = { x: slot.x, y: slot.y }
      positions[node.uuid] = point
      if (point.x !== node.x || point.y !== node.y) moved.push(node.uuid)
      placed += 1
    }
  }

  for (const node of pending.slice(placed)) unplaced.push(node.uuid)

  return {
    positions,
    moved,
    unplaced,
    columns,
    rows: rowsUsed,
    pitchWidth,
    pitchHeight,
    cardWidth,
    cardHeight,
    origin,
    placedCount: placed,
  }
}
