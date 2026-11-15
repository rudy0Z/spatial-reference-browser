//! R-tree viewport culler — SPATIAL_BROWSER_MASTER_SPEC.md Phase 2 item 1a.
//!
//! Indexes every node's axis-aligned bounding box (`x, y, width, height`)
//! in an [`rstar::RTree`] so `SpatialCanvas.tsx` only pushes position
//! updates to the nodes a viewport query returns (O(log N) per query), and
//! so Ghost Echo spawning can reject candidate tether points that would
//! land on top of an existing card (AABB overlap check).
//!
//! Determinism: query results are always returned in ascending id order —
//! rstar's internal traversal order is an implementation detail callers
//! must never observe.
//!
//! No-panic law: non-finite coordinates are rejected at the entry points
//! (`insert` keeps finite entries only; queries with non-finite bounds
//! return empty/false) instead of poisoning the tree.

use rstar::{PointDistance, RTree, RTreeObject, AABB};
use std::collections::BTreeSet;

/// A node card's box in world space. `x, y` is the TOP-LEFT corner — the
/// same coordinates the store persists and React Flow renders
/// (mirrors `MoodboardPoint`/node position semantics).
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct CullBox {
    /// Node identifier (e.g. `nodeIndex` from the TS wrapper). Kept opaque.
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl CullBox {
    pub fn new(id: u32, x: f64, y: f64, width: f64, height: f64) -> Self {
        CullBox { id, x, y, width, height }
    }

    /// Finite-and-sane predicate: rejects NaN/±Inf and negative sizes.
    pub fn is_valid(&self) -> bool {
        self.x.is_finite() && self.y.is_finite() && self.width.is_finite() && self.height.is_finite() && self.width >= 0.0 && self.height >= 0.0
    }

    fn aabb(&self) -> AABB<[f64; 2]> {
        // Caller validated finiteness; from_corners is monotonic in min/max.
        AABB::from_corners([self.x, self.y], [self.x + self.width, self.y + self.height])
    }

    /// Strict-intersection test exactly matching the TS reference
    /// (`app/src/lib/moodboard.ts` `rectIntersects`): touching edges do NOT
    /// count as overlap.
    pub fn strict_intersects(a: &CullBox, b: &CullBox) -> bool {
        a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
    }
}

impl RTreeObject for CullBox {
    type Envelope = AABB<[f64; 2]>;

    fn envelope(&self) -> Self::Envelope {
        self.aabb()
    }
}

impl PointDistance for CullBox {
    /// Squared euclidean distance from the point to the box (0 inside) —
    /// matches `AABB::distance_2` as required by the trait contract.
    fn distance_2(&self, point: &[f64; 2]) -> f64 {
        self.aabb().distance_2(point)
    }

    fn contains_point(&self, point: &[f64; 2]) -> bool {
        point[0] >= self.x && point[0] <= self.x + self.width && point[1] >= self.y && point[1] <= self.y + self.height
    }
}

/// R-tree over node card boxes. Cheap mutations: entries live in a sorted
/// vec and the tree rebuilds lazily (bulk-load of 1,000 cards is ~tens of
/// microseconds, orders of magnitude below a frame budget), keeping every
/// state deterministic and the hot read path allocation-free.
pub struct ViewportCuller {
    entries: Vec<CullBox>,
    tree: Option<RTree<CullBox>>,
}

impl Default for ViewportCuller {
    fn default() -> Self {
        Self::new()
    }
}

impl ViewportCuller {
    pub fn new() -> Self {
        ViewportCuller { entries: Vec::new(), tree: None }
    }

    /// Build from a batch of boxes (drops non-finite entries, dedupes ids
    /// keeping the last occurrence — mirrors re-`insert` semantics).
    pub fn from_boxes(boxes: impl IntoIterator<Item = CullBox>) -> Self {
        let mut culler = ViewportCuller::new();
        for b in boxes {
            culler.insert(b);
        }
        culler
    }

    /// Insert or replace the box for `id`. Non-finite boxes are ignored
    /// (no-panic law) — the previous box for that id stays live.
    pub fn insert(&mut self, b: CullBox) {
        if !b.is_valid() {
            return;
        }
        if let Some(slot) = self.entries.iter_mut().find(|e| e.id == b.id) {
            *slot = b;
        } else {
            self.entries.push(b);
        }
        self.tree = None;
    }

    /// Remove the box for `id`. Returns whether anything was removed.
    pub fn remove(&mut self, id: u32) -> bool {
        let before = self.entries.len();
        self.entries.retain(|e| e.id != id);
        let removed = self.entries.len() != before;
        if removed {
            self.tree = None;
        }
        removed
    }

    /// Number of indexed boxes.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Rebuild (or fetch the cached) rtree. Bulk load → balanced tree.
    fn tree(&self) -> Option<&RTree<CullBox>> {
        self.tree.as_ref()
    }

    fn ensure_tree(&mut self) {
        if self.tree.is_none() {
            self.tree = Some(RTree::bulk_load(self.entries.clone()));
        }
    }

    /// Viewport query with margin: every card whose AABB intersects the
    /// viewport rect grown by `margin` on all sides. Returned ids ascending.
    ///
    /// Non-finite viewport inputs → empty result (no panic).
    pub fn query_viewport(&mut self, min_x: f64, min_y: f64, max_x: f64, max_y: f64, margin: f64) -> Vec<u32> {
        self.query_viewport_iter(min_x, min_y, max_x, max_y, margin).into_iter().collect()
    }

    /// Iterator flavor of [`ViewportCuller::query_viewport`] for callers
    /// that don't want the Vec.
    pub fn query_viewport_iter(
        &mut self,
        min_x: f64,
        min_y: f64,
        max_x: f64,
        max_y: f64,
        margin: f64,
    ) -> impl Iterator<Item = u32> + '_ {
        let ids: BTreeSet<u32> = if min_x.is_finite() && min_y.is_finite() && max_x.is_finite() && max_y.is_finite() && margin.is_finite() && min_x <= max_x && min_y <= max_y {
            self.ensure_tree();
            let grown = AABB::from_corners([min_x - margin, min_y - margin], [max_x + margin, max_y + margin]);
            match self.tree() {
                Some(tree) => tree.locate_in_envelope_intersecting(&grown).map(|b| b.id).collect(),
                None => BTreeSet::new(),
            }
        } else {
            BTreeSet::new()
        };
        ids.into_iter()
    }

    /// Nearest-neighbour hit-testing: the card whose AABB is closest to the
    /// point, plus the EUCLIDEAN distance (0.0 when the point lies inside
    /// the card). Ties break on ascending id.
    pub fn nearest(&mut self, x: f64, y: f64) -> Option<(u32, f64)> {
        if !x.is_finite() || !y.is_finite() || self.entries.is_empty() {
            return None;
        }
        self.ensure_tree();
        let tree = self.tree()?;
        // neighbor iterator yields ascending distance; track the minimum and
        // break as soon as the iterator moves past it. Ties at the minimum
        // break on ascending id.
        let point = [x, y];
        let mut best: Option<(u32, f64)> = None; // (id, d2)
        for candidate in tree.nearest_neighbor_iter(&point) {
            let d2 = candidate.envelope().distance_2(&point);
            match best {
                None => best = Some((candidate.id, d2)),
                Some((id, best_d2)) => {
                    if d2 < best_d2 {
                        best = Some((candidate.id, d2));
                    } else if d2 == best_d2 && candidate.id < id {
                        best = Some((candidate.id, d2));
                    } else if d2 > best_d2 {
                        break; // sorted — nothing further can be closer
                    }
                }
            }
        }
        best.map(|(id, d2)| (id, d2.sqrt()))
    }

    /// Point hit-test: the topmost (smallest-area, then smallest-id) card
    /// containing the point, if any.
    pub fn hit_test(&mut self, x: f64, y: f64) -> Option<u32> {
        if !x.is_finite() || !y.is_finite() {
            return None;
        }
        let mut best: Option<(u32, f64)> = None; // (id, area)
        for entry in &self.entries {
            let inside = x >= entry.x && x <= entry.x + entry.width && y >= entry.y && y <= entry.y + entry.height;
            if inside {
                let area = entry.width * entry.height;
                let better = match best {
                    None => true,
                    Some((id, best_area)) => area < best_area || (area == best_area && entry.id < id),
                };
                if better {
                    best = Some((entry.id, area));
                }
            }
        }
        best.map(|(id, _)| id)
    }

    /// AABB overlap check: does any indexed card strictly intersect the
    /// given rect (touching edges do not count — matches the TS
    /// `rectIntersects` reference)? Used to keep Ghost Echoes off existing
    /// cards. Non-finite inputs → false.
    pub fn overlaps_any(&self, x: f64, y: f64, width: f64, height: f64) -> bool {
        if !x.is_finite() || !y.is_finite() || !width.is_finite() || !height.is_finite() || width < 0.0 || height < 0.0 {
            return false;
        }
        let probe = CullBox::new(u32::MAX, x, y, width, height);
        self.entries.iter().any(|e| CullBox::strict_intersects(&probe, e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn box_at(id: u32, x: f64, y: f64) -> CullBox {
        CullBox::new(id, x, y, 260.0, 199.0)
    }

    #[test]
    fn query_viewport_returns_intersecting_ids_sorted() {
        let mut culler = ViewportCuller::from_boxes([
            box_at(7, 0.0, 0.0),
            box_at(3, 500.0, 500.0),
            box_at(12, -300.0, -50.0),
            box_at(1, 9000.0, 9000.0),
        ]);
        let ids = culler.query_viewport(-100.0, -100.0, 400.0, 400.0, 0.0);
        // box 7 (0,0) is inside; box 12 (-300,-50, 260x199) spans x -300..-40,
        // y -50..149 → overlaps the rect's left edge → also returned
        assert_eq!(ids, vec![7, 12]);
        let ids = culler.query_viewport(-100.0, -100.0, 520.0, 610.0, 0.0);
        assert_eq!(ids, vec![3, 7, 12]); // ascending id order
        // margin grows the query rect to (-300,-300)..(560,499):
        // box 7 inside; box 12 (x -300..-40, y -50..149) overlaps;
        // box 3 (y 500..699) misses by 1px (499 < 500)
        let ids = culler.query_viewport(0.0, 0.0, 260.0, 199.0, 300.0);
        assert_eq!(ids, vec![7, 12]);
    }

    #[test]
    fn query_viewport_margin_semantics() {
        // Card at [0,0,260,199]; query rect touching its right edge.
        let mut culler = ViewportCuller::from_boxes([box_at(1, 0.0, 0.0)]);
        // inclusive intersect at the boundary with margin 1
        let ids = culler.query_viewport(261.0, 50.0, 270.0, 60.0, 1.0);
        assert_eq!(ids, vec![1]);
        // 2px away with margin 1 → miss
        let ids = culler.query_viewport(262.0, 50.0, 272.0, 60.0, 1.0);
        assert!(ids.is_empty());
    }

    #[test]
    fn query_viewport_rejects_inverted_and_nonfinite() {
        let mut culler = ViewportCuller::from_boxes([box_at(1, 0.0, 0.0)]);
        assert!(culler.query_viewport(10.0, 10.0, -10.0, 20.0, 0.0).is_empty());
        assert!(culler.query_viewport(f64::NAN, 0.0, 10.0, 10.0, 0.0).is_empty());
        assert!(culler.query_viewport(0.0, f64::INFINITY, 10.0, 10.0, 0.0).is_empty());
        assert!(culler.query_viewport(0.0, 0.0, 10.0, 10.0, f64::NAN).is_empty());
    }

    #[test]
    fn nearest_returns_zero_distance_inside_card() {
        let mut culler = ViewportCuller::from_boxes([box_at(4, 100.0, 100.0), box_at(9, 800.0, 800.0)]);
        let (id, dist) = culler.nearest(150.0, 120.0).expect("nearest");
        assert_eq!(id, 4);
        assert_eq!(dist, 0.0);
        // outside, closest corner (100,100): dx 20, dy 40 → √2000
        let (id, dist) = culler.nearest(80.0, 60.0).expect("nearest");
        assert_eq!(id, 4);
        assert!((dist - (20f64.powi(2) + 40f64.powi(2)).sqrt()).abs() < 1e-12);
    }

    #[test]
    fn nearest_tiebreaks_on_ascending_id() {
        // Two identical cards → identical distance → id 3 wins over 5.
        let mut culler = ViewportCuller::from_boxes([box_at(5, 0.0, 0.0), box_at(3, 0.0, 0.0)]);
        let (id, _) = culler.nearest(10.0, 10.0).expect("nearest");
        assert_eq!(id, 3);
    }

    #[test]
    fn nearest_empty_and_nonfinite() {
        let mut culler = ViewportCuller::new();
        assert!(culler.nearest(0.0, 0.0).is_none());
        let mut culler = ViewportCuller::from_boxes([box_at(1, 0.0, 0.0)]);
        assert!(culler.nearest(f64::NAN, 0.0).is_none());
        assert!(culler.nearest(0.0, f64::INFINITY).is_none());
    }

    #[test]
    fn hit_test_prefers_smallest_area_then_smallest_id() {
        let mut culler = ViewportCuller::from_boxes([
            CullBox::new(2, 0.0, 0.0, 400.0, 300.0),
            CullBox::new(1, 0.0, 0.0, 100.0, 100.0),
        ]);
        assert_eq!(culler.hit_test(50.0, 50.0), Some(1));
        // equal areas → smaller id
        let mut culler = ViewportCuller::from_boxes([
            CullBox::new(9, 0.0, 0.0, 100.0, 100.0),
            CullBox::new(8, 0.0, 0.0, 100.0, 100.0),
        ]);
        assert_eq!(culler.hit_test(50.0, 50.0), Some(8));
        assert_eq!(culler.hit_test(f64::NAN, 0.0), None);
    }

    #[test]
    fn overlaps_any_strict_semantics() {
        let culler = ViewportCuller::from_boxes([box_at(1, 0.0, 0.0)]); // 260x199
        assert!(culler.overlaps_any(0.0, 0.0, 10.0, 10.0));
        assert!(culler.overlaps_any(-5.0, -5.0, 10.0, 10.0));
        assert!(culler.overlaps_any(250.0, 100.0, 50.0, 50.0));
        // touching edges do NOT count (strict <)
        assert!(!culler.overlaps_any(260.0, 0.0, 10.0, 10.0));
        assert!(!culler.overlaps_any(0.0, 199.0, 10.0, 10.0));
        // non-finite → false, never panic
        assert!(!culler.overlaps_any(f64::NAN, 0.0, 10.0, 10.0));
        assert!(!culler.overlaps_any(0.0, 0.0, f64::INFINITY, 10.0));
    }

    #[test]
    fn insert_replace_remove() {
        let mut culler = ViewportCuller::new();
        assert!(culler.is_empty());
        culler.insert(box_at(1, 0.0, 0.0));
        culler.insert(box_at(1, 5000.0, 5000.0)); // replaces
        assert_eq!(culler.len(), 1);
        assert!(culler.query_viewport(0.0, 0.0, 100.0, 100.0, 0.0).is_empty());
        assert_eq!(culler.query_viewport(4990.0, 4990.0, 5100.0, 5100.0, 0.0), vec![1]);
        // non-finite insert ignored, previous box survives
        culler.insert(CullBox::new(1, f64::NAN, 0.0, 10.0, 10.0));
        assert_eq!(culler.query_viewport(4990.0, 4990.0, 5100.0, 5100.0, 0.0), vec![1]);
        // negative size ignored
        culler.insert(CullBox::new(2, 0.0, 0.0, -5.0, 10.0));
        assert_eq!(culler.len(), 1);
        assert!(culler.remove(1));
        assert!(!culler.remove(1));
        assert!(culler.is_empty());
    }

    #[test]
    fn many_boxes_query_is_exhaustive_brute_force_match() {
        // 250 scattered cards; the rtree result must equal brute force.
        let mut boxes = Vec::new();
        for i in 0..250u32 {
            let x = ((i as f64).mul_add(97.31, -1200.0)) % 900.0;
            let y = ((i as f64).mul_add(151.7, -900.0)) % 700.0;
            boxes.push(CullBox::new(i, x, y, 120.0 + (i % 7) as f64 * 10.0, 80.0 + (i % 5) as f64 * 10.0));
        }
        let entries: Vec<CullBox> = boxes.clone();
        let mut culler = ViewportCuller::from_boxes(boxes);
        for step in 0..25 {
            let mx = step as f64 * 40.0 - 500.0;
            let my = step as f64 * 25.0 - 300.0;
            let (qx0, qy0, qx1, qy1) = (mx, my, mx + 320.0, my + 200.0);
            let mut expected: Vec<u32> = entries
                .iter()
                .filter(|e| {
                    let b = e;
                    b.x <= qx1 && b.x + b.width >= qx0 && b.y <= qy1 && b.y + b.height >= qy0
                })
                .map(|e| e.id)
                .collect();
            expected.sort_unstable();
            let got = culler.query_viewport(qx0, qy0, qx1, qy1, 0.0);
            assert_eq!(got, expected, "step {step}");
        }
    }
}
