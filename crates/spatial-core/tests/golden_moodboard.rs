//! Golden test: the Rust moodboard solver must reproduce the ORIGINAL
//! TypeScript (`app/src/lib/moodboard.ts`, executed via Node with type
//! stripping) BIT FOR BIT — every f64 compared through `to_bits()`, plus
//! moved/unplaced/columns/rows/placedCount and the TS object insertion
//! order of `positions`.

use serde::Deserialize;
use spatial_core::moodboard::{compute_moodboard_grid, MoodboardGridOptions, MoodboardNodeInput};

#[derive(Deserialize)]
struct GoldenScenario {
    name: String,
    nodes: Vec<MoodboardNodeInput>,
    #[serde(default)]
    options: OptionsRaw,
    expected: ExpectedRaw,
}

#[derive(Deserialize, Default)]
struct OptionsRaw {
    #[serde(default, rename = "cardWidth")]
    card_width: Option<f64>,
    #[serde(default, rename = "cardHeight")]
    card_height: Option<f64>,
    #[serde(default, rename = "pitchAspect")]
    pitch_aspect: Option<f64>,
    #[serde(default, rename = "pitchPaddingY")]
    pitch_padding_y: Option<f64>,
    #[serde(default, rename = "maxColumns")]
    max_columns: Option<f64>,
    #[serde(default, rename = "overlapMargin")]
    overlap_margin: Option<f64>,
}

#[derive(Deserialize)]
struct ExpectedRaw {
    /// TS `Record<string, MoodboardPoint>` — deserialized as a
    /// `serde_json::Map` (IndexMap with `preserve_order`) so the TS
    /// insertion order survives for the order assertion.
    positions: serde_json::Map<String, serde_json::Value>,
    moved: Vec<String>,
    unplaced: Vec<String>,
    columns: f64,
    rows: f64,
    #[serde(rename = "pitchWidth")]
    pitch_width: f64,
    #[serde(rename = "pitchHeight")]
    pitch_height: f64,
    #[serde(rename = "cardWidth")]
    card_width: f64,
    #[serde(rename = "cardHeight")]
    card_height: f64,
    origin: OriginRaw,
    #[serde(rename = "placedCount")]
    placed_count: f64,
}

#[derive(Deserialize)]
struct OriginRaw {
    x: f64,
    y: f64,
}

fn assert_bits(label: &str, scenario: &str, a: f64, b: f64) {
    assert_eq!(
        a.to_bits(),
        b.to_bits(),
        "{scenario}/{label}: bit mismatch — rust {a:?} vs ts {b:?}"
    );
}

#[test]
fn rust_moodboard_matches_typescript_bit_for_bit() {
    let golden_path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/golden/moodboard_golden.json");
    let raw = std::fs::read_to_string(golden_path).expect("golden JSON exists — run scripts/gen_golden.mjs");
    let scenarios: Vec<GoldenScenario> = serde_json::from_str(&raw).expect("golden JSON parses");

    assert!(scenarios.len() >= 12, "scenarios present: {}", scenarios.len());

    for scenario in &scenarios {
        let options = MoodboardGridOptions {
            card_width: scenario.options.card_width,
            card_height: scenario.options.card_height,
            pitch_aspect: scenario.options.pitch_aspect,
            pitch_padding_y: scenario.options.pitch_padding_y,
            max_columns: scenario.options.max_columns,
            overlap_margin: scenario.options.overlap_margin,
        };
        let result = compute_moodboard_grid(&scenario.nodes, &options);
        let expected = &scenario.expected;
        let name = &scenario.name;

        // positions: every uuid with bit-identical coordinates, in the same
        // insertion order (pinned in input order, then reading order)
        assert_eq!(
            result.positions.len(),
            expected.positions.len(),
            "{name}: positions count"
        );
        let ts_pairs: Vec<(String, [f64; 2])> = expected
            .positions
            .iter()
            .map(|(uuid, value)| {
                let x = value["x"].as_f64().expect("x number");
                let y = value["y"].as_f64().expect("y number");
                (uuid.clone(), [x, y])
            })
            .collect();
        for ((rust_uuid, rust_point), (ts_uuid, ts_point)) in result.positions.iter().zip(ts_pairs.iter()) {
            assert_eq!(rust_uuid, ts_uuid, "{name}: position key order");
            assert_bits("positions.x", name, rust_point[0], ts_point[0]);
            assert_bits("positions.y", name, rust_point[1], ts_point[1]);
        }

        assert_eq!(result.moved, expected.moved, "{name}: moved list (order matters)");
        assert_eq!(result.unplaced, expected.unplaced, "{name}: unplaced list");
        assert_bits("columns", name, result.columns, expected.columns);
        assert_bits("rows", name, result.rows, expected.rows);
        assert_bits("pitchWidth", name, result.pitch_width, expected.pitch_width);
        assert_bits("pitchHeight", name, result.pitch_height, expected.pitch_height);
        assert_bits("cardWidth", name, result.card_width, expected.card_width);
        assert_bits("cardHeight", name, result.card_height, expected.card_height);
        assert_bits("origin.x", name, result.origin[0], expected.origin.x);
        assert_bits("origin.y", name, result.origin[1], expected.origin.y);
        assert_bits("placedCount", name, result.placed_count, expected.placed_count);
    }
}

#[test]
fn ts_constants_match_rust_constants() {
    let constants_path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/golden/constants.json");
    let raw = std::fs::read_to_string(constants_path).expect("constants JSON exists — run scripts/gen_golden.mjs");
    let constants: serde_json::Value = serde_json::from_str(&raw).expect("parses");

    use spatial_core::moodboard::*;
    let pairs: Vec<(&str, f64)> = vec![
        ("cardWidth", MOODBOARD_CARD_WIDTH),
        ("cardHeight", MOODBOARD_CARD_HEIGHT),
        ("pitchAspect", MOODBOARD_PITCH_ASPECT),
        ("pitchPaddingY", MOODBOARD_PITCH_PADDING_Y),
        ("pitchHeight", MOODBOARD_PITCH_HEIGHT),
        ("pitchWidth", MOODBOARD_PITCH_WIDTH),
        ("slotInsetX", MOODBOARD_SLOT_INSET_X),
        ("slotInsetY", MOODBOARD_SLOT_INSET_Y),
        ("overlapMargin", MOODBOARD_OVERLAP_MARGIN),
    ];
    for (key, value) in pairs {
        let ts = constants[key].as_f64().unwrap_or(f64::NAN);
        assert_eq!(value.to_bits(), ts.to_bits(), "constant {key}: rust {value:?} vs ts {ts:?}");
    }
}
