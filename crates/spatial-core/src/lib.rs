//! spatial-core — deterministic spatial engine for the Spatial Browser.
//!
//! Ported from the pure TypeScript modules under `app/src/` exactly as the
//! SPATIAL_BROWSER_MASTER_SPEC.md Phase 2 section requires:
//!
//! | module            | ported from                                   |
//! |-------------------|-----------------------------------------------|
//! | [`cull`]          | (new) rstar R-tree viewport culler — spec §Phase 2 item 1 |
//! | [`moodboard`]     | `app/src/lib/moodboard.ts` (exact port, golden-tested) |
//! | [`force`]         | `app/src/hooks/useHybridForceLayout.ts` (d3-force v3 algorithm port) |
//! | [`search`]        | `app/src/store/useGraphStore.ts` fuzzy + Ghost Echo scorer, `app/src/lib/embed.ts` |
//! | [`boids`]         | (new) spatial-hash flocking — HANDOFF.md §5.10 |
//!
//! Laws honored everywhere:
//! - Deterministic: same input → same output. No clocks, no `Math.random`,
//!   stable comparators, IEEE-754 arithmetic identical to JS (all f64).
//! - No panics on user input: NaN/Infinity inputs are handled (never
//!   `unwrap`ed), adversarial sizes are clamped, index math is checked.
//! - Pure modules: every module is unit-tested without WASM and the whole
//!   crate compiles for both `x86_64` tests and `wasm32-unknown-unknown`.

pub mod boids;
pub mod cull;
pub mod force;
pub mod moodboard;
pub(crate) mod quadtree;
pub mod search;

#[cfg(feature = "wasm")]
pub mod wasm;

/// Common result type — the WASM surface converts errors to `JsValue`.
#[allow(dead_code)]
pub type CoreResult<T> = Result<T, CoreError>;

/// Non-panicking error type for caller-input contract violations.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum CoreError {
    /// A numeric input was NaN or infinite where finite was required.
    NonFiniteNumber(&'static str),
    /// An input array exceeded the safety cap (wasm-side guard).
    InputTooLarge { cap: usize, got: usize },
}

impl core::fmt::Display for CoreError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            CoreError::NonFiniteNumber(what) => write!(f, "non-finite number: {what}"),
            CoreError::InputTooLarge { cap, got } => write!(f, "input too large: got {got}, cap {cap}"),
        }
    }
}

impl std::error::Error for CoreError {}
