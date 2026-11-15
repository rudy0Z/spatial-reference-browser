//! Port of d3-quadtree v3 (add / cover / visit / visitAfter) used by the
//! d3-force algorithm port in [`crate::force`].
//!
//! Faithfulness notes (sources: d3/d3-quadtree v3.0.0 `add.js`, `cover.js`,
//! `visit.js`, `visitAfter.js`):
//! - Extent starts as a unit square `[floor(x), floor(x)+1]` and doubles
//!   outward via `cover` until all points fit — identical boundaries.
//! - Exactly coincident points chain on one leaf (`add.js:36-39`); the
//!   newest point becomes the chain HEAD (matters for float sum order in
//!   the many-body port, which sums head → tail).
//! - `visit` is a preorder with pruning (callback true → skip subtree),
//!   children in index order 0,1,2,3; `visit_after` is postorder, children
//!   0..3 then parent — the exact callback orders the force ports rely on.
//! - NaN points are ignored on insert (`add.js:8`, `cover.js:2`).
//!
//! Implementation shape: a flat node arena instead of d3's linked objects —
//! every traversal is iterative (explicit stacks), so adversarial
//! near-coincident inputs that push the leaf-split depth past 1,000 can
//! never overflow the stack. Structure and arithmetic are the d3 algorithm.
//!
//! Deliberate hardening over d3: d3-quadtree guards insert/cover with
//! `isNaN` only, and `cover(±Infinity)` never terminates (the doubling loop
//! can never contain an infinite point). The no-panic/no-hang law here
//! rejects every NON-FINITE point (NaN and ±Inf) at `add`/`cover`.

/// One quadtree node. A leaf carries a coincident chain (`indices`, head
/// first, head coords in `x`/`y`); an internal carries 4 child slots. The
/// payload fields are written by the accumulate passes (many-body charge /
/// collide radius) exactly where d3 writes `quad.value/x/y` and `quad.r`.
#[derive(Debug, Clone)]
pub(crate) struct QuadNode {
    pub is_internal: bool,
    pub children: [Option<usize>; 4],
    /// Leaf: coincident chain, HEAD FIRST (d3 `quad.data`, then `.next`).
    pub indices: Vec<usize>,
    /// Leaf coords (shared by the whole chain — equal by construction).
    pub x: f64,
    pub y: f64,
    /// many-body payload (d3 `quad.value` / `quad.x` / `quad.y`).
    pub charge: f64,
    pub charge_x: f64,
    pub charge_y: f64,
    /// collide payload (d3 `quad.r`).
    pub radius: f64,
}

impl QuadNode {
    fn empty_leaf(index: usize, x: f64, y: f64) -> Self {
        QuadNode { is_internal: false, children: [None; 4], indices: vec![index], x, y, charge: 0.0, charge_x: 0.0, charge_y: 0.0, radius: 0.0 }
    }

    fn empty_internal() -> Self {
        QuadNode { is_internal: true, children: [None; 4], indices: Vec::new(), x: 0.0, y: 0.0, charge: 0.0, charge_x: 0.0, charge_y: 0.0, radius: 0.0 }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct QuadTree {
    pub nodes: Vec<QuadNode>,
    pub root: Option<usize>,
    /// Extent; NaN until the first `cover` (d3 leaves `_x0` NaN).
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

impl Default for QuadTree {
    fn default() -> Self {
        QuadTree { nodes: Vec::new(), root: None, x0: f64::NAN, y0: f64::NAN, x1: f64::NAN, y1: f64::NAN }
    }
}

impl QuadTree {
    pub fn new() -> Self {
        Self::default()
    }

    fn new_leaf(&mut self, index: usize, x: f64, y: f64) -> usize {
        self.nodes.push(QuadNode::empty_leaf(index, x, y));
        self.nodes.len() - 1
    }

    fn new_internal(&mut self) -> usize {
        self.nodes.push(QuadNode::empty_internal());
        self.nodes.len() - 1
    }

    /// Port of `quadtree(points, x, y)` + `addAll` (d3-quadtree add.js:50-84):
    /// extent from the finite points, `cover(min).cover(max)`, then
    /// sequential `add` per point in input order (it determines chain heads).
    pub fn from_points(points: &[(f64, f64)]) -> QuadTree {
        let mut tree = QuadTree::new();
        // A quadtree over n points has at most ~2n-1 nodes; reserving avoids
        // arena reallocation during the add pass (hot per-tick path).
        tree.nodes.reserve(points.len() * 2 + 2);
        let mut x0 = f64::INFINITY;
        let mut y0 = f64::INFINITY;
        let mut x1 = f64::NEG_INFINITY;
        let mut y1 = f64::NEG_INFINITY;
        for (x, y) in points.iter() {
            if !x.is_finite() || !y.is_finite() {
                continue;
            }
            if *x < x0 {
                x0 = *x;
            }
            if *x > x1 {
                x1 = *x;
            }
            if *y < y0 {
                y0 = *y;
            }
            if *y > y1 {
                y1 = *y;
            }
        }
        if x0 > x1 || y0 > y1 {
            return tree; // no finite points → empty tree (add.js:73)
        }
        tree.cover(x0, y0);
        tree.cover(x1, y1);
        for (i, (x, y)) in points.iter().enumerate() {
            tree.add(*x, *y, i);
        }
        tree
    }

    /// Port of d3-quadtree `cover` (cover.js) — doubles the extent outward
    /// until the point is inside, re-parenting the (internal) root at every
    /// doubling; a leaf root is never re-parented (`cover.js:35`).
    pub fn cover(&mut self, x: f64, y: f64) {
        if !x.is_finite() || !y.is_finite() {
            return;
        }
        if self.x0.is_nan() {
            // Unit square anchored on floor(x), floor(y) — integer bounds so
            // later doublings don't drift (cover.js:12-15).
            self.x0 = x.floor();
            self.y0 = y.floor();
            self.x1 = self.x0 + 1.0;
            self.y1 = self.y0 + 1.0;
            return;
        }
        let mut x0 = self.x0;
        let mut y0 = self.y0;
        let mut x1 = self.x1;
        let mut y1 = self.y1;
        let mut z = x1 - x0;
        if z == 0.0 {
            z = 1.0;
        }
        while x0 > x || x >= x1 || y0 > y || y >= y1 {
            let i = ((y < y0) as usize) << 1 | ((x < x0) as usize);
            z *= 2.0;
            let (nx0, ny0, nx1, ny1) = match i {
                0 => (x0, y0, x0 + z, y0 + z),
                1 => (x1 - z, y0, x1, y0 + z),
                2 => (x0, y1 - z, x0 + z, y1),
                _ => (x1 - z, y1 - z, x1, y1),
            };
            x0 = nx0;
            y0 = ny0;
            x1 = nx1;
            y1 = ny1;
            // Wrap only an internal root (cover.js:26-35).
            let root_is_internal = self.root.map(|r| self.nodes[r].is_internal).unwrap_or(false);
            if root_is_internal {
                let old = self.root.take().unwrap();
                let parent = self.new_internal();
                self.nodes[parent].children[i] = Some(old);
                self.root = Some(parent);
            }
        }
        self.x0 = x0;
        self.y0 = y0;
        self.x1 = x1;
        self.y1 = y1;
    }

    /// Port of d3-quadtree `add` (add.js:7-48): descend internals, prepend to
    /// an exactly-coincident chain, or split until the points separate.
    pub fn add(&mut self, x: f64, y: f64, index: usize) {
        if !x.is_finite() || !y.is_finite() {
            return;
        }
        let Some(root) = self.root else {
            self.root = Some(self.new_leaf(index, x, y));
            return;
        };

        let mut x0 = self.x0;
        let mut y0 = self.y0;
        let mut x1 = self.x1;
        let mut y1 = self.y1;

        // Walk down internal nodes to the leaf slot (add.js:30-34).
        let mut cur = root;
        while self.nodes[cur].is_internal {
            let xm = (x0 + x1) / 2.0;
            let ym = (y0 + y1) / 2.0;
            let right = x >= xm;
            let bottom = y >= ym;
            if right {
                x0 = xm;
            } else {
                x1 = xm;
            }
            if bottom {
                y0 = ym;
            } else {
                y1 = ym;
            }
            let i = ((bottom as usize) << 1) | (right as usize);
            match self.nodes[cur].children[i] {
                None => {
                    let leaf = self.new_leaf(index, x, y);
                    self.nodes[cur].children[i] = Some(leaf);
                    return;
                }
                Some(child) => cur = child,
            }
        }

        // Leaf reached. Exactly coincident → new point becomes chain head
        // (add.js:36-39: `leaf.next = node, parent[i] = leaf`).
        {
            let leaf = &self.nodes[cur];
            if x == leaf.x && y == leaf.y {
                self.nodes[cur].indices.insert(0, index);
                return;
            }
        }

        // Split: lift the old leaf out, create internals along the descent
        // while both points map to the same child, then place both
        // (add.js:41-47).
        let old = std::mem::replace(&mut self.nodes[cur], QuadNode::empty_internal());
        let (xp, yp, old_indices) = match old {
            QuadNode { is_internal: false, indices, x: xp, y: yp, .. } => (xp, yp, indices),
            _ => unreachable!("leaf expected after walk"),
        };
        loop {
            let xm = (x0 + x1) / 2.0;
            let ym = (y0 + y1) / 2.0;
            let right = x >= xm;
            let bottom = y >= ym;
            if right {
                x0 = xm;
            } else {
                x1 = xm;
            }
            if bottom {
                y0 = ym;
            } else {
                y1 = ym;
            }
            let i = ((bottom as usize) << 1) | (right as usize);
            let j = ((yp >= ym) as usize) << 1 | ((xp >= xm) as usize);
            if i != j {
                let new_leaf = self.new_leaf(index, x, y);
                let old_leaf = self.nodes.len();
                self.nodes.push(QuadNode { indices: old_indices, x: xp, y: yp, ..QuadNode::empty_leaf(0, 0.0, 0.0) });
                self.nodes[cur].children[i] = Some(new_leaf);
                self.nodes[cur].children[j] = Some(old_leaf);
                return;
            }
            let deeper = self.new_internal();
            self.nodes[cur].children[i] = Some(deeper);
            cur = deeper;
        }
    }

    /// Port of d3-quadtree `visit` (visit.js): preorder, callback return
    /// true prunes the subtree, children visited in index order 0..3.
    #[allow(dead_code)]
    pub fn visit<F>(&self, callback: F)
    where
        F: FnMut(&QuadNode, f64, f64, f64, f64) -> bool,
    {
        let mut stack = Vec::new();
        self.visit_with_stack(&mut stack, callback);
    }

    /// d3 `visit` with a reusable stack — the hot-path flavor; the
    /// allocating [`QuadTree::visit`] convenience wraps this. (The
    /// `#[allow(dead_code)]` covers test-only use of the convenience.)
    #[allow(dead_code)]
    /// stack across thousands of visit calls (the per-tick force hot path).
    pub fn visit_with_stack<F>(&self, stack: &mut Vec<(usize, f64, f64, f64, f64)>, mut callback: F)
    where
        F: FnMut(&QuadNode, f64, f64, f64, f64) -> bool,
    {
        stack.clear();
        let Some(root) = self.root else { return };
        stack.push((root, self.x0, self.y0, self.x1, self.y1));
        while let Some((idx, x0, y0, x1, y1)) = stack.pop() {
            let node = &self.nodes[idx];
            if callback(node, x0, y0, x1, y1) {
                continue; // pruned
            }
            if node.is_internal {
                let xm = (x0 + x1) / 2.0;
                let ym = (y0 + y1) / 2.0;
                // visit.js pushes 3,2,1,0 so pops yield 0,1,2,3.
                for i in (0..4).rev() {
                    if let Some(child) = node.children[i] {
                        let (cx0, cy0, cx1, cy1) = match i {
                            0 => (x0, y0, xm, ym),
                            1 => (xm, y0, x1, ym),
                            2 => (x0, ym, xm, y1),
                            _ => (xm, ym, x1, y1),
                        };
                        stack.push((child, cx0, cy0, cx1, cy1));
                    }
                }
            }
        }
    }

    /// Postorder accumulation pass — d3's `visitAfter` + `accumulate`
    /// (many-body) / `prepare` (collide). Children are finalized 0..3
    /// before their parent, exactly matching the float sum order of
    /// `accumulate` (manyBody.js:29-53).
    #[allow(dead_code)]
    pub fn visit_after<F>(&mut self, mut callback: F)
    where
        F: FnMut(&mut QuadNode, f64, f64, f64, f64),
    {
        let Some(root) = self.root else { return };
        let mut stack: Vec<(usize, f64, f64, f64, f64)> = Vec::new();
        let mut postorder: Vec<(usize, f64, f64, f64, f64)> = Vec::new();
        stack.push((root, self.x0, self.y0, self.x1, self.y1));
        while let Some((idx, x0, y0, x1, y1)) = stack.pop() {
            if self.nodes[idx].is_internal {
                let xm = (x0 + x1) / 2.0;
                let ym = (y0 + y1) / 2.0;
                for i in (0..4).rev() {
                    if let Some(child) = self.nodes[idx].children[i] {
                        let (cx0, cy0, cx1, cy1) = match i {
                            0 => (x0, y0, xm, ym),
                            1 => (xm, y0, x1, ym),
                            2 => (x0, ym, xm, y1),
                            _ => (xm, ym, x1, y1),
                        };
                        stack.push((child, cx0, cy0, cx1, cy1));
                    }
                }
            }
            postorder.push((idx, x0, y0, x1, y1));
        }
        while let Some((idx, x0, y0, x1, y1)) = postorder.pop() {
            callback(&mut self.nodes[idx], x0, y0, x1, y1);
        }
    }

    /// many-body `accumulate` (manyBody.js:29-53): internal = charge sum +
    /// |charge|-weighted centroid over children in order 0..3 (zero-charge
    /// children skipped, mirroring the `&& (c = Math.abs(q.value))` guard);
    /// leaf = sum of chain strengths in head→tail order, centroid = head
    /// coords (`q.x = q.data.x`).
    pub fn accumulate_charge(&mut self, strengths: &[f64]) {
        let Some(root) = self.root else { return };
        // Fused single-pass iterative postorder: (idx, parent_finalized).
        // Children finalize before their parent, in child order 0..3, which
        // is the float sum order of d3's `accumulate` (manyBody.js:29-53).
        let mut stack: Vec<(usize, bool)> = Vec::with_capacity(self.nodes.len());
        stack.push((root, false));
        while let Some((idx, ready)) = stack.pop() {
            if ready {
                let mut total = 0.0;
                let mut weight = 0.0;
                let mut wx = 0.0;
                let mut wy = 0.0;
                let children: [Option<usize>; 4] = self.nodes[idx].children;
                for child_idx in children.iter().flatten() {
                    let child = &self.nodes[*child_idx];
                    // d3: `if ((q = quad[i]) && (c = Math.abs(q.value)))` —
                    // null children and zero-charge children are skipped.
                    let c = child.charge.abs();
                    if c != 0.0 {
                        total += child.charge;
                        weight += c;
                        wx += c * child.charge_x;
                        wy += c * child.charge_y;
                    }
                }
                self.nodes[idx].charge = total;
                self.nodes[idx].charge_x = if weight != 0.0 { wx / weight } else { f64::NAN };
                self.nodes[idx].charge_y = if weight != 0.0 { wy / weight } else { f64::NAN };
                continue;
            }
            if self.nodes[idx].is_internal {
                stack.push((idx, true));
                for i in (0..4).rev() {
                    if let Some(child) = self.nodes[idx].children[i] {
                        stack.push((child, false));
                    }
                }
            } else {
                let mut total = 0.0;
                for &i in &self.nodes[idx].indices {
                    total += strengths[i];
                }
                self.nodes[idx].charge = total;
                self.nodes[idx].charge_x = self.nodes[idx].x;
                self.nodes[idx].charge_y = self.nodes[idx].y;
            }
        }
    }

    /// collide `prepare` (collide.js:65-72): leaf radius = the HEAD point's
    /// radius (`radii[quad.data.index]`); internal = max child radius.
    pub fn prepare_radius(&mut self, radii: &[f64]) {
        let Some(root) = self.root else { return };
        let mut stack: Vec<(usize, bool)> = Vec::with_capacity(self.nodes.len());
        stack.push((root, false));
        while let Some((idx, ready)) = stack.pop() {
            if ready {
                let mut max_r = 0.0f64;
                let children: [Option<usize>; 4] = self.nodes[idx].children;
                for child_idx in children.iter().flatten() {
                    let r = self.nodes[*child_idx].radius;
                    if r > max_r {
                        max_r = r;
                    }
                }
                self.nodes[idx].radius = max_r;
                continue;
            }
            if self.nodes[idx].is_internal {
                stack.push((idx, true));
                for i in (0..4).rev() {
                    if let Some(child) = self.nodes[idx].children[i] {
                        stack.push((child, false));
                    }
                }
            } else {
                let head = self.nodes[idx].indices[0];
                self.nodes[idx].radius = radii[head];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cover_starts_unit_square_and_doubles() {
        let mut tree = QuadTree::new();
        tree.cover(5.7, 3.1);
        assert_eq!(tree.x0, 5.0);
        assert_eq!(tree.y0, 3.0);
        assert_eq!(tree.x1, 6.0);
        assert_eq!(tree.y1, 4.0);
        // point far outside → doubles until covered
        tree.cover(-20.0, -20.0);
        assert!(tree.x0 <= -20.0 && tree.y0 <= -20.0 && tree.x1 > 5.7 && tree.y1 > 3.1);
        // NaN ignored
        tree.cover(f64::NAN, 0.0);
        assert_eq!(tree.x0, (tree.x0), "extent unchanged");
    }

    #[test]
    fn add_coincident_points_chain_with_newest_head() {
        let points = [(10.0, 10.0), (10.0, 10.0), (10.0, 10.0)];
        let tree = QuadTree::from_points(&points);
        let root = tree.root.expect("root");
        let leaf = &tree.nodes[root];
        assert!(!leaf.is_internal);
        // newest point is the chain head: indices [2, 1, 0]
        assert_eq!(leaf.indices, vec![2, 1, 0]);
        assert_eq!((leaf.x, leaf.y), (10.0, 10.0));
    }

    #[test]
    fn add_distant_points_split_into_children() {
        let points = [(0.5, 0.5), (9.5, 9.5), (1.5, 8.5), (8.5, 1.5)];
        let tree = QuadTree::from_points(&points);
        let root = tree.root.expect("root");
        let node = &tree.nodes[root];
        assert!(node.is_internal);
        let child_count = node.children.iter().flatten().count();
        assert_eq!(child_count, 4, "four points land in four quadrants");
        // each child is a leaf holding exactly its point
        for child in node.children.iter().flatten() {
            let c = &tree.nodes[*child];
            assert!(!c.is_internal);
            assert_eq!(c.indices.len(), 1);
        }
    }

    #[test]
    fn nan_points_ignored() {
        let points = [(1.0, 1.0), (f64::NAN, 2.0), (3.0, f64::INFINITY)];
        let tree = QuadTree::from_points(&points);
        assert!(tree.root.is_some());
        let mut leaves = 0;
        tree.visit(|node, _, _, _, _| {
            if !node.is_internal {
                leaves += 1;
            }
            false
        });
        assert_eq!(leaves, 1, "only the finite point lands");
    }

    #[test]
    fn visit_is_preorder_with_prune_and_child_order() {
        let points = [(1.0, 1.0), (9.0, 9.0), (1.0, 9.0), (9.0, 1.0)];
        let tree = QuadTree::from_points(&points);
        let mut order: Vec<String> = Vec::new();
        tree.visit(|node, x0, y0, x1, y1| {
            let label = if node.is_internal {
                // child index order observable via extent order — record shape
                format!("I({x0},{y0},{x1},{y1})")
            } else {
                format!("L{}", node.indices[0])
            };
            order.push(label);
            false
        });
        // root visited first, then children in index order 0,1,2,3
        assert!(order[0].starts_with('I'), "root internal first: {order:?}");
        let leaf_order: Vec<usize> = order[1..].iter().filter(|s| s.starts_with('L')).map(|s| s[1..].parse().unwrap()).collect();
        // children 0,1,2,3 map to (x0,y0),(x1,y0),(x0,y1),(x1,y1) quadrants
        // point 0 (1,1) → quadrant 0; point 3 (9,1) → quadrant 1;
        // point 2 (1,9) → quadrant 2; point 1 (9,9) → quadrant 3
        assert_eq!(leaf_order, vec![0, 3, 2, 1], "preorder child order 0..3: {order:?}");
    }

    #[test]
    fn visit_after_is_postorder_children_before_parent() {
        let points = [(1.0, 1.0), (9.0, 9.0)];
        let mut tree = QuadTree::from_points(&points);
        let mut order: Vec<String> = Vec::new();
        tree.visit_after(|node, _, _, _, _| {
            order.push(if node.is_internal { "I".into() } else { format!("L{}", node.indices[0]) });
        });
        // both children finalized before the parent
        assert_eq!(order.len(), 3);
        assert!(!order[0].starts_with('I'));
        assert!(!order[1].starts_with('I'));
        assert_eq!(order[2], "I");
    }

    #[test]
    fn accumulate_charge_sums_leaf_chain_in_head_order() {
        let points = [(5.0, 5.0), (5.0, 5.0), (5.0, 5.0)];
        let mut tree = QuadTree::from_points(&points);
        let strengths = vec![1.0, 2.0, 4.0];
        tree.accumulate_charge(&strengths);
        let root = tree.root.unwrap();
        let leaf = &tree.nodes[root];
        // d3 sums head → tail: [2, 1, 0] → 4 + 2 + 1 (same total either way;
        // order matters for non-commutative floats — verified structurally)
        assert_eq!(leaf.charge, 7.0);
        assert_eq!((leaf.charge_x, leaf.charge_y), (5.0, 5.0));
    }

    #[test]
    fn accumulate_charge_internal_centroid_skips_zero_children() {
        // two well-separated points, strengths +10 and 0
        let points = [(1.0, 1.0), (20.0, 20.0)];
        let mut tree = QuadTree::from_points(&points);
        let strengths = vec![10.0, 0.0];
        tree.accumulate_charge(&strengths);
        let root = tree.root.unwrap();
        let node = &tree.nodes[root];
        assert_eq!(node.charge, 10.0);
        // zero-charge child skipped from the centroid (d3 guard)
        assert_eq!((node.charge_x, node.charge_y), (1.0, 1.0));
    }

    #[test]
    fn prepare_radius_leaf_head_and_internal_max() {
        let points = [(1.0, 1.0), (20.0, 20.0), (20.0, 20.0)];
        let mut tree = QuadTree::from_points(&points);
        let radii = vec![3.0, 5.0, 9.0];
        tree.prepare_radius(&radii);
        // leaf holding points 1,2 (coincident): head = 2 → radius 9
        let mut leaf_r = 0.0;
        let mut internal_r = 0.0;
        tree.visit(|node, _, _, _, _| {
            if node.is_internal {
                internal_r = node.radius;
            } else {
                leaf_r = node.radius;
            }
            false
        });
        assert_eq!(leaf_r, 9.0, "leaf uses HEAD point radius (d3 quad.data)");
        assert_eq!(internal_r, 9.0, "internal = max child radius");
    }

    #[test]
    fn deep_split_no_stack_overflow() {
        // Two points one ULP apart (0.5 vs 0.5 + 2^-53) force a ~53-level
        // split chain inside the unit-square extent; the iterative add must
        // not overflow the stack. (0.5 + 1e-300 would round back to 0.5 and
        // coincidentally chain instead.)
        let points = [(0.5, 0.5), (0.5000000000000001, 0.5)];
        assert_ne!(points[0].0, points[1].0, "must be distinct f64s");
        let tree = QuadTree::from_points(&points);
        assert!(tree.root.is_some());
        let mut depth = 0;
        let mut node = tree.root.unwrap();
        while tree.nodes[node].is_internal {
            depth += 1;
            let next = tree.nodes[node].children.iter().flatten().next().unwrap();
            node = *next;
        }
        assert!(depth > 30, "adversarially deep tree built iteratively: depth {depth}");
    }

    #[test]
    fn empty_point_set_yields_empty_tree() {
        let tree = QuadTree::from_points(&[(f64::NAN, f64::NAN)]);
        assert!(tree.root.is_none());
        assert!(tree.x0.is_nan());
    }
}
