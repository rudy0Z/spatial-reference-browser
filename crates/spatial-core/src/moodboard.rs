//! Moodboard contact-sheet solver — EXACT port of `app/src/lib/moodboard.ts`
//! (SPATIAL_BROWSER_MASTER_SPEC.md Phase 2 item 1b: "Port `computeMoodboardGrid`
//! (384×240 16:10 pitch, 260×199 card size, 12px pinned keep-out margin,
//! stable reading-order sort)").
//!
//! Bit-exactness contract with the TypeScript source:
//! - All arithmetic is f64, performed in the SAME expression order as the TS
//!   code (IEEE-754 is deterministic across both runtimes for +, -, *, /,
//!   sqrt, ceil — every op here is one of those).
//! - Comparators mirror the TS semantics including JS string `<` (UTF-16
//!   code-unit ordering) and `!==` strictness (+0.0 == -0.0 counts as equal,
//!   matching JS abstract equality used by `point.x !== node.x`).
//! - `tests/golden_moodboard.rs` pins this module against golden JSON
//!   produced by running the ORIGINAL TypeScript through Node — bit-for-bit.
//!
//! The TS header comment (moodboard.ts:1-40) documents the design laws; they
//! all hold here by construction since the control flow is line-for-line.

/// Phase 1.5 reference card width (ZCODE_MASTER_PROMPT.md §Phase 1.5). TS: moodboard.ts:107
pub const MOODBOARD_CARD_WIDTH: f64 = 260.0;
/// 16:10 edge-to-edge preview (162.5) + clean 36px footer, rounded. TS: moodboard.ts:109
pub const MOODBOARD_CARD_HEIGHT: f64 = 199.0;
/// Uniform pitch cell aspect — width:height = 16:10. TS: moodboard.ts:111
pub const MOODBOARD_PITCH_ASPECT: f64 = 16.0 / 10.0;
/// Vertical breathing room: card height + this = pitch height. TS: moodboard.ts:113
pub const MOODBOARD_PITCH_PADDING_Y: f64 = 41.0;
/// 199 + 41 = 240. TS: moodboard.ts:115
pub const MOODBOARD_PITCH_HEIGHT: f64 = MOODBOARD_CARD_HEIGHT + MOODBOARD_PITCH_PADDING_Y;
/// 240 × 16/10 = 384 — the pitch is exactly 16:10. TS: moodboard.ts:117
pub const MOODBOARD_PITCH_WIDTH: f64 = MOODBOARD_PITCH_HEIGHT * MOODBOARD_PITCH_ASPECT;
/// Horizontal inset centering the 260px card inside the 384px pitch. TS: moodboard.ts:119
pub const MOODBOARD_SLOT_INSET_X: f64 = (MOODBOARD_PITCH_WIDTH - MOODBOARD_CARD_WIDTH) / 2.0;
/// Vertical inset centering the 199px card inside the 240px pitch. TS: moodboard.ts:121
pub const MOODBOARD_SLOT_INSET_Y: f64 = (MOODBOARD_PITCH_HEIGHT - MOODBOARD_CARD_HEIGHT) / 2.0;
/// Default clearance around pinned anchors when rejecting slots. TS: moodboard.ts:123
pub const MOODBOARD_OVERLAP_MARGIN: f64 = 12.0;

/// A node's slot is its card's TOP-LEFT corner. TS: moodboard.ts:44
pub type MoodboardPoint = [f64; 2];

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MoodboardNodeInput {
    pub uuid: String,
    /// Persisted top-left position.
    pub x: f64,
    pub y: f64,
    /// Pinned anchors are preserved exactly and excluded from the sheet.
    /// Serde name matches the TS field so the golden JSON and the WASM
    /// surface speak the same shape.
    #[serde(rename = "isPinned")]
    pub is_pinned: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct MoodboardRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct MoodboardGridOptions {
    /// Reference card width. Default 260.
    #[serde(rename = "cardWidth", default, skip_serializing_if = "Option::is_none")]
    pub card_width: Option<f64>,
    /// Reference card height. Default 199.
    #[serde(rename = "cardHeight", default, skip_serializing_if = "Option::is_none")]
    pub card_height: Option<f64>,
    /// Pitch cell aspect (width / height). Default 16/10.
    #[serde(rename = "pitchAspect", default, skip_serializing_if = "Option::is_none")]
    pub pitch_aspect: Option<f64>,
    /// Vertical breathing room added to the card height to form the pitch.
    /// Default 41.
    #[serde(rename = "pitchPaddingY", default, skip_serializing_if = "Option::is_none")]
    pub pitch_padding_y: Option<f64>,
    /// Hard cap on columns (1..). Default: uncapped.
    #[serde(rename = "maxColumns", default, skip_serializing_if = "Option::is_none")]
    pub max_columns: Option<f64>,
    /// Clearance grown around pinned footprints when rejecting slots. Default 12.
    #[serde(rename = "overlapMargin", default, skip_serializing_if = "Option::is_none")]
    pub overlap_margin: Option<f64>,
}

/// TS `MoodboardGridResult` (moodboard.ts:73-100). `positions` is a Vec of
/// (uuid, point) pairs PRESERVING TS INSERTION ORDER: pinned nodes in input
/// order first, then placed nodes in reading order.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct MoodboardGridResult {
    /// uuid → next top-left position, as (uuid, [x, y]) pairs PRESERVING TS
    /// INSERTION ORDER: pinned nodes in input order first, then placed
    /// nodes in reading order.
    pub positions: Vec<(String, MoodboardPoint)>,
    /// Uuids whose computed slot differs from their input position, in
    /// placement (reading) order. Pinned anchors never appear here.
    pub moved: Vec<String>,
    /// Uuids the solver could not place (defensive row guard only).
    pub unplaced: Vec<String>,
    /// Fitted column count (0 when there was nothing to place).
    pub columns: f64,
    /// Rows actually used by placed cards.
    pub rows: f64,
    #[serde(rename = "pitchWidth")]
    pub pitch_width: f64,
    #[serde(rename = "pitchHeight")]
    pub pitch_height: f64,
    #[serde(rename = "cardWidth")]
    pub card_width: f64,
    #[serde(rename = "cardHeight")]
    pub card_height: f64,
    /// Top-left of the sheet's first pitch cell (world coordinates).
    pub origin: MoodboardPoint,
    #[serde(rename = "placedCount")]
    pub placed_count: f64,
}

/// TS `rectIntersects` (moodboard.ts:129-131) — strict: touching edges do
/// NOT intersect. Expression order preserved bit-for-bit.
fn rect_intersects(a: &MoodboardRect, b: &MoodboardRect) -> bool {
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/// JS string `<` semantics: compare UTF-16 code units.
/// (Rust `str` Ord is UTF-8 byte order, which differs for supplementary-
/// plane characters; uuids are ASCII in practice but this is the exact port.)
fn js_string_lt(a: &str, b: &str) -> bool {
    let mut ai = a.encode_utf16();
    let mut bi = b.encode_utf16();
    loop {
        match (ai.next(), bi.next()) {
            (None, None) => return false,
            (None, Some(_)) => return true,
            (Some(_), None) => return false,
            (Some(x), Some(y)) => {
                if x != y {
                    return x < y;
                }
            }
        }
    }
}

/// TS `readingOrderCompare` (moodboard.ts:134-139): top → bottom, left →
/// right, uuid tiebreak. JS comparator sign semantics: NaN y/x would compare
/// false-false → Equal; `unwrap_or(Equal)` mirrors that.
fn reading_order_compare(a: &MoodboardNodeInput, b: &MoodboardNodeInput) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    if a.y != b.y {
        return (a.y - b.y).partial_cmp(&0.0).unwrap_or(Ordering::Equal);
    }
    if a.x != b.x {
        return (a.x - b.x).partial_cmp(&0.0).unwrap_or(Ordering::Equal);
    }
    if a.uuid == b.uuid {
        return Ordering::Equal;
    }
    if js_string_lt(&a.uuid, &b.uuid) {
        Ordering::Less
    } else {
        Ordering::Greater
    }
}

/// Compute the moodboard contact-sheet grid for a set of region nodes.
///
/// Exact port of TS `computeMoodboardGrid` (moodboard.ts:148-293). Every
/// branch, loop bound and expression order matches the source; see the TS
/// header for the design rationale (idempotency, pinned keep-out, near-
/// square column fit).
pub fn compute_moodboard_grid(nodes: &[MoodboardNodeInput], options: &MoodboardGridOptions) -> MoodboardGridResult {
    let card_width = options.card_width.unwrap_or(MOODBOARD_CARD_WIDTH);
    let card_height = options.card_height.unwrap_or(MOODBOARD_CARD_HEIGHT);
    let pitch_aspect = options.pitch_aspect.unwrap_or(MOODBOARD_PITCH_ASPECT);
    let pitch_padding_y = options.pitch_padding_y.unwrap_or(MOODBOARD_PITCH_PADDING_Y);
    let max_columns = options.max_columns.unwrap_or(f64::INFINITY);
    let overlap_margin = options.overlap_margin.unwrap_or(MOODBOARD_OVERLAP_MARGIN);

    let pitch_height = card_height + pitch_padding_y;
    let pitch_width = pitch_height * pitch_aspect;
    let inset_x = (pitch_width - card_width) / 2.0;
    let inset_y = (pitch_height - card_height) / 2.0;

    let mut positions: Vec<(String, MoodboardPoint)> = Vec::new();
    let mut moved: Vec<String> = Vec::new();
    let unplaced: Vec<String> = Vec::new();

    // Pinned anchors keep their exact position; their card footprints (grown
    // by the clearance margin) become the keep-out rects. TS: moodboard.ts:168-204
    let mut pinned_rects: Vec<MoodboardRect> = Vec::new();
    let mut unpinned: Vec<&MoodboardNodeInput> = Vec::new();
    let mut all_min_x = f64::INFINITY;
    let mut all_min_y = f64::INFINITY;
    let mut all_max_x = f64::NEG_INFINITY;
    let mut all_max_y = f64::NEG_INFINITY;
    let mut pin_min_x = f64::INFINITY;
    let mut pin_min_y = f64::INFINITY;
    let mut pin_max_x = f64::NEG_INFINITY;
    let mut pin_max_y = f64::NEG_INFINITY;
    let mut pinned_count: f64 = 0.0;
    for node in nodes {
        let center_x = node.x + card_width / 2.0;
        let center_y = node.y + card_height / 2.0;
        all_min_x = all_min_x.min(center_x);
        all_min_y = all_min_y.min(center_y);
        all_max_x = all_max_x.max(center_x);
        all_max_y = all_max_y.max(center_y);
        if node.is_pinned {
            pinned_count += 1.0;
            pin_min_x = pin_min_x.min(center_x);
            pin_min_y = pin_min_y.min(center_y);
            pin_max_x = pin_max_x.max(center_x);
            pin_max_y = pin_max_y.max(center_y);
            positions.push((node.uuid.clone(), [node.x, node.y]));
            pinned_rects.push(MoodboardRect {
                x: node.x - overlap_margin,
                y: node.y - overlap_margin,
                width: card_width + overlap_margin * 2.0,
                height: card_height + overlap_margin * 2.0,
            });
        } else {
            unpinned.push(node);
        }
    }
    let total = nodes.len() as f64;
    // Anchor rule (TS: moodboard.ts:206-209): pinned anchors dominate when
    // present; otherwise the whole region's card-center bbox.
    let anchor_x = if pinned_count > 0.0 { (pin_min_x + pin_max_x) / 2.0 } else { (all_min_x + all_max_x) / 2.0 };
    let anchor_y = if pinned_count > 0.0 { (pin_min_y + pin_max_y) / 2.0 } else { (all_min_y + all_max_y) / 2.0 };
    let mut origin: MoodboardPoint = if total > 0.0 { [anchor_x, anchor_y] } else { [0.0, 0.0] };

    if unpinned.is_empty() {
        return MoodboardGridResult {
            positions,
            moved,
            unplaced,
            columns: 0.0,
            rows: 0.0,
            pitch_width,
            pitch_height,
            card_width,
            card_height,
            origin,
            placed_count: 0.0,
        };
    }

    // Columns fitted to the count: the classic near-square contact sheet.
    // TS: moodboard.ts:228-231 — Math.ceil(Math.sqrt(n)); sqrt/ceil are
    // correctly-rounded IEEE ops → identical results in Rust.
    let fitted = (unpinned.len() as f64).sqrt().ceil();
    let columns = 1.0f64.max(max_columns.min(fitted));
    let estimated_rows = (unpinned.len() as f64 / columns).ceil();

    // The sheet lands where the region already lives. TS: moodboard.ts:233-236
    origin[0] -= (columns * pitch_width) / 2.0;
    origin[1] -= (estimated_rows * pitch_height) / 2.0;

    // TS: [...unpinned].sort(readingOrderCompare) — Array.sort is stable
    // (ES2019+) and the comparator is a total order on distinct uuids.
    let mut pending: Vec<&MoodboardNodeInput> = unpinned.clone();
    pending.sort_by(|a, b| reading_order_compare(a, b));

    // TS: moodboard.ts:241-243 — deterministic safety net.
    let max_rows = estimated_rows + pinned_rects.len() as f64 * 2.0 + 16.0;
    let mut placed: f64 = 0.0;
    let mut rows_used: f64 = 0.0;

    // TS: moodboard.ts:247-276 — `placed < pending.length && row < maxRows`
    // loop conditions and the blocked-slot skip, expression-for-expression.
    let mut row: f64 = 0.0;
    while placed < pending.len() as f64 && row < max_rows {
        rows_used = row + 1.0;
        let mut col: f64 = 0.0;
        while col < columns && placed < pending.len() as f64 {
            let slot = MoodboardRect {
                x: origin[0] + col * pitch_width + inset_x,
                y: origin[1] + row * pitch_height + inset_y,
                width: card_width,
                height: card_height,
            };
            let grown = MoodboardRect {
                x: slot.x - overlap_margin,
                y: slot.y - overlap_margin,
                width: card_width + overlap_margin * 2.0,
                height: card_height + overlap_margin * 2.0,
            };
            let mut blocked = false;
            for keep_out in &pinned_rects {
                if rect_intersects(&grown, keep_out) {
                    blocked = true;
                    break;
                }
            }
            if blocked {
                col += 1.0;
                continue;
            }
            let node = pending[placed as usize];
            let point: MoodboardPoint = [slot.x, slot.y];
            positions.push((node.uuid.clone(), point));
            // TS: `point.x !== node.x || point.y !== node.y` — JS !== treats
            // +0.0 === -0.0, which f64 `!=` mirrors exactly.
            if point[0] != node.x || point[1] != node.y {
                moved.push(node.uuid.clone());
            }
            placed += 1.0;
            col += 1.0;
        }
        row += 1.0;
    }

    // TS: moodboard.ts:278
    let mut unplaced = unplaced;
    for node in pending.iter().skip(placed as usize) {
        unplaced.push(node.uuid.clone());
    }

    MoodboardGridResult {
        positions,
        moved,
        unplaced,
        columns,
        rows: rows_used,
        pitch_width,
        pitch_height,
        card_width,
        card_height,
        origin,
        placed_count: placed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(uuid: &str, x: f64, y: f64, pinned: bool) -> MoodboardNodeInput {
        MoodboardNodeInput { uuid: uuid.to_string(), x, y, is_pinned: pinned }
    }

    fn pos(result: &MoodboardGridResult, uuid: &str) -> MoodboardPoint {
        result.positions.iter().find(|(u, _)| u == uuid).map(|(_, p)| *p).expect("uuid present")
    }

    #[test]
    fn canonical_constants_match_ts() {
        // moodboard.ts:107-123
        assert_eq!(MOODBOARD_CARD_WIDTH, 260.0);
        assert_eq!(MOODBOARD_CARD_HEIGHT, 199.0);
        assert_eq!(MOODBOARD_PITCH_ASPECT, 16.0 / 10.0);
        assert_eq!(MOODBOARD_PITCH_PADDING_Y, 41.0);
        assert_eq!(MOODBOARD_PITCH_HEIGHT, 240.0);
        // 240 * (16/10) in IEEE f64 — 384.00000000000006, same as JS
        assert_eq!(MOODBOARD_PITCH_WIDTH.to_bits(), (240.0f64 * (16.0f64 / 10.0f64)).to_bits());
        assert_eq!(MOODBOARD_SLOT_INSET_X.to_bits(), ((MOODBOARD_PITCH_WIDTH - 260.0) / 2.0).to_bits());
        assert_eq!(MOODBOARD_SLOT_INSET_Y, 20.5);
        assert_eq!(MOODBOARD_OVERLAP_MARGIN, 12.0);
    }

    #[test]
    fn empty_input_origin_zero() {
        let result = compute_moodboard_grid(&[], &MoodboardGridOptions::default());
        assert_eq!(result.columns, 0.0);
        assert_eq!(result.rows, 0.0);
        assert_eq!(result.origin, [0.0, 0.0]);
        assert_eq!(result.placed_count, 0.0);
        assert!(result.positions.is_empty());
    }

    #[test]
    fn all_pinned_early_return() {
        let result = compute_moodboard_grid(&[node("a", 10.0, 20.0, true), node("b", 300.0, 40.0, true)], &MoodboardGridOptions::default());
        assert_eq!(result.columns, 0.0);
        assert_eq!(result.placed_count, 0.0);
        assert_eq!(pos(&result, "a"), [10.0, 20.0]);
        assert_eq!(pos(&result, "b"), [300.0, 40.0]);
        assert!(result.moved.is_empty());
        // anchor = bbox center of pinned card centers
        assert_eq!(result.origin, [(10.0 + 260.0 / 2.0 + 300.0 + 260.0 / 2.0) / 2.0, (20.0 + 99.5 + 40.0 + 99.5) / 2.0]);
    }

    #[test]
    fn single_node_gets_one_slot() {
        let result = compute_moodboard_grid(&[node("a", 100.0, 80.0, false)], &MoodboardGridOptions::default());
        assert_eq!(result.columns, 1.0);
        assert_eq!(result.rows, 1.0);
        assert_eq!(result.placed_count, 1.0);
        // anchor = card center (230, 179.5); origin = anchor - half pitch
        let origin_x = 100.0 + 130.0 - (1.0 * MOODBOARD_PITCH_WIDTH) / 2.0;
        let origin_y = 80.0 + 99.5 - (1.0 * MOODBOARD_PITCH_HEIGHT) / 2.0;
        assert_eq!(result.origin, [origin_x, origin_y]);
        // slot = origin + inset — and here the two f64 roundings cancel
        // EXACTLY (origin_x = 37.999999999999971, inset = 62.000000000000028
        // → 100.0; 59.5 + 20.5 → 80.0), so the card is already on its slot:
        // the TS reference returns (100, 80) with moved [] — idempotent.
        let got = pos(&result, "a");
        assert_eq!(got, [100.0, 80.0]);
        assert!(result.moved.is_empty());
    }

    #[test]
    fn reading_order_sort_and_column_fit() {
        // 12 nodes → ceil(sqrt(12)) = 4 columns, 3 rows; reading order fills.
        let mut nodes = Vec::new();
        for i in 0..12u32 {
            let x = ((i % 4) as f64) * 400.0 + (i as f64) * 3.0;
            let y = ((i / 4) as f64) * 300.0;
            nodes.push(node(&format!("n{i}"), x, y, false));
        }
        let result = compute_moodboard_grid(&nodes, &MoodboardGridOptions::default());
        assert_eq!(result.columns, 4.0);
        assert_eq!(result.rows, 3.0);
        assert_eq!(result.placed_count, 12.0);
        assert_eq!(result.moved.len(), 12);
        // The topmost node in input scatter (smallest y, then x) lands first:
        // y = 0 row nodes n0..n3; smallest x among them is n0 (x = 0*400+0).
        // Its slot = origin + inset (row 0, col 0).
        let first = &result.moved[0];
        let second = &result.moved[1];
        let p0 = pos(&result, first);
        let p1 = pos(&result, second);
        assert!(p1[0] - p0[0] > MOODBOARD_PITCH_WIDTH - 1.0);
    }

    #[test]
    fn uuid_tiebreak_is_js_string_order() {
        // identical coordinates → uuid lexicographic order decides placement
        let nodes = [node("n2", 0.0, 0.0, false), node("n10", 0.0, 0.0, false)];
        let result = compute_moodboard_grid(&nodes, &MoodboardGridOptions::default());
        // "n10" < "n2" in UTF-16 order → n10 gets slot 0
        assert_eq!(result.moved[0], "n10");
        assert_eq!(result.moved[1], "n2");
    }

    #[test]
    fn pinned_anchor_centres_sheet() {
        // Two pinned far apart + a few unpinned → origin anchored on pin
        // centers, slots never overlap pinned keep-out rects.
        let nodes = [
            node("pin-a", 0.0, 0.0, true),
            node("pin-b", 1600.0, 0.0, true),
            node("c1", 300.0, 500.0, false),
            node("c2", 600.0, 800.0, false),
            node("c3", 900.0, 100.0, false),
        ];
        let result = compute_moodboard_grid(&nodes, &MoodboardGridOptions::default());
        assert_eq!(result.placed_count, 3.0);
        // anchor = bbox center of pinned centers: ((130 + 1730)/2, (99.5+99.5)/2)
        let anchor_x = (0.0 + 130.0 + 1600.0 + 130.0) / 2.0;
        let anchor_y = 99.5;
        let rows = 1.0f64.max((3.0f64 / result.columns).ceil());
        let expected_ox = anchor_x - (result.columns * result.pitch_width) / 2.0;
        let expected_oy = anchor_y - (rows * result.pitch_height) / 2.0;
        assert_eq!(result.origin, [expected_ox, expected_oy]);
        // every placed slot's grown rect must miss both pinned keep-outs
        for (uuid, p) in &result.positions {
            if uuid.starts_with("pin") {
                continue;
            }
            let grown = MoodboardRect { x: p[0] - 12.0, y: p[1] - 12.0, width: 260.0 + 24.0, height: 199.0 + 24.0 };
            for pin in [(0.0, 0.0), (1600.0, 0.0)] {
                let keep_out = MoodboardRect { x: pin.0 - 12.0, y: pin.1 - 12.0, width: 284.0, height: 223.0 };
                assert!(!rect_intersects(&grown, &keep_out), "{uuid} overlaps pin {pin:?}");
            }
        }
    }

    #[test]
    fn keep_out_blocks_flow_around_pin() {
        // One pinned card exactly where slot (0,0) would land → cards flow
        // to later slots instead of overlapping it.
        let nodes = [
            node("blocker", 100.0, 100.0, true),
            node("a", 10.0, 10.0, false),
            node("b", 20.0, 20.0, false),
        ];
        let result = compute_moodboard_grid(&nodes, &MoodboardGridOptions::default());
        assert_eq!(result.placed_count, 2.0);
        for (uuid, p) in result.positions.iter() {
            if uuid == "blocker" {
                continue; // pinned keeps its coords; only placed slots are checked
            }
            let grown = MoodboardRect { x: p[0] - 12.0, y: p[1] - 12.0, width: 284.0, height: 223.0 };
            let keep_out = MoodboardRect { x: 100.0 - 12.0, y: 100.0 - 12.0, width: 284.0, height: 223.0 };
            assert!(!rect_intersects(&grown, &keep_out), "slot {p:?} intersects blocker keep-out");
        }
    }

    #[test]
    fn max_columns_cap() {
        let nodes: Vec<MoodboardNodeInput> = (0..7).map(|i| node(&format!("n{i}"), i as f64 * 310.0, i as f64 * 240.0, false)).collect();
        let options = MoodboardGridOptions { max_columns: Some(2.0), ..Default::default() };
        let result = compute_moodboard_grid(&nodes, &options);
        assert_eq!(result.columns, 2.0);
        assert_eq!(result.rows, 4.0);
    }

    #[test]
    fn idempotent_second_run_moves_nothing() {
        let nodes: Vec<MoodboardNodeInput> = (0..9)
            .map(|i| {
                let x = (i % 3) as f64 * 390.0 + i as f64;
                let y = (i / 3) as f64 * 250.0 - i as f64 * 0.5;
                node(&format!("n{i}"), x, y, false)
            })
            .collect();
        let first = compute_moodboard_grid(&nodes, &MoodboardGridOptions::default());
        let settled: Vec<MoodboardNodeInput> = nodes
            .iter()
            .map(|n| {
                let p = first.positions.iter().find(|(u, _)| *u == n.uuid).unwrap().1;
                MoodboardNodeInput { uuid: n.uuid.clone(), x: p[0], y: p[1], is_pinned: n.is_pinned }
            })
            .collect();
        let second = compute_moodboard_grid(&settled, &MoodboardGridOptions::default());
        assert!(second.moved.is_empty(), "tidying a tidied region must move nothing, got {:?}", second.moved);
        assert_eq!(second.placed_count, 9.0);
        for n in &settled {
            assert_eq!(pos(&second, &n.uuid), [n.x, n.y]);
        }
    }

    #[test]
    fn custom_card_size_respects_aspect() {
        // card 100x60, padding 40 → pitch 100x? aspect 2 → pitch h = 100, w = 200
        let nodes = [node("a", 0.0, 0.0, false)];
        let options = MoodboardGridOptions {
            card_width: Some(100.0),
            card_height: Some(60.0),
            pitch_aspect: Some(2.0),
            pitch_padding_y: Some(40.0),
            overlap_margin: Some(0.0),
            max_columns: None,
        };
        let result = compute_moodboard_grid(&nodes, &options);
        assert_eq!(result.pitch_height, 100.0);
        assert_eq!(result.pitch_width, 200.0);
        assert_eq!(result.card_width, 100.0);
    }

    #[test]
    fn deterministic_repeated_calls() {
        let nodes: Vec<MoodboardNodeInput> = (0..25)
            .map(|i| node(&format!("u{}", 25 - i), ((i * 37) % 2000) as f64, ((i * 53) % 1500) as f64, i % 5 == 0))
            .collect();
        let a = compute_moodboard_grid(&nodes, &MoodboardGridOptions::default());
        let b = compute_moodboard_grid(&nodes, &MoodboardGridOptions::default());
        assert_eq!(a, b);
    }
}
