//! Seed-deterministic k-means (Lloyd) over int8 vectors widened to f32.
//!
//! Determinism contract (FROZEN quantizer): given identical (vectors, dim,
//! nlist, seed, max_iter) this produces byte-identical centroids on every run
//! and matches ivf-pq-js-fallback.js bit-for-bit. Sources of nondeterminism are
//! removed: (1) init = Fisher-Yates partial shuffle driven by mulberry32 (no
//! Math.random, no HashSet); (2) assignment tie-break = lowest centroid index;
//! (3) empty-cluster reseed = the point with max distance to its centroid,
//! tie-break lowest point index; (4) no float-order-dependent parallelism.

use crate::rng::Mulberry32;

/// Squared L2 between an int8 vector slice and an f32 centroid. Accumulated in
/// f64 (promote each f32 component to f64) to byte-match the JS fallback, which
/// reads Float32Array as f64-promoted and accumulates in f64. The centroid VALUES
/// remain f32 in both impls (stored via `as f32` / Math.fround), only the
/// distance accumulator is f64 — this is the parity-critical choice.
#[inline]
fn sq_dist_i8_f32(v: &[i8], c: &[f32]) -> f64 {
    let mut s = 0f64;
    for k in 0..v.len() {
        let d = (v[k] as f64) - (c[k] as f64);
        s += d * d;
    }
    s
}

/// Nearest centroid for one vector. Returns (index, sq_dist). Tie → lower index.
#[inline]
fn nearest(v: &[i8], centroids: &[f32], nlist: usize, dim: usize) -> (usize, f64) {
    let mut best = 0usize;
    let mut best_d = f64::INFINITY;
    for c in 0..nlist {
        let cen = &centroids[c * dim..c * dim + dim];
        let d = sq_dist_i8_f32(v, cen);
        if d < best_d {
            best_d = d;
            best = c;
        }
    }
    (best, best_d)
}

/// Deterministic init: Fisher-Yates partial shuffle of [0,n) using mulberry32,
/// take the first `nlist` indices as initial centroids. Mirrors the JS fallback.
fn init_centroids(vectors: &[i8], n: usize, dim: usize, nlist: usize, seed: u32) -> Vec<f32> {
    let mut idx: Vec<usize> = (0..n).collect();
    let mut rng = Mulberry32::new(seed);
    let pick = nlist.min(n);
    for i in 0..pick {
        // j in [i, n)
        let j = i + rng.next_below(n - i);
        idx.swap(i, j);
    }
    let mut centroids = vec![0f32; nlist * dim];
    for c in 0..nlist {
        // If nlist > n, wrap deterministically (degenerate small-input case).
        let src = idx[c % n];
        let v = &vectors[src * dim..src * dim + dim];
        for k in 0..dim {
            centroids[c * dim + k] = v[k] as f32;
        }
    }
    centroids
}

/// Run Lloyd's algorithm. Returns f32 centroids (nlist*dim), row-major.
pub fn train(
    vectors: &[i8],
    n: usize,
    dim: usize,
    nlist: usize,
    seed: u32,
    max_iter: u32,
) -> Vec<f32> {
    if n == 0 || dim == 0 || nlist == 0 {
        return vec![0f32; nlist * dim];
    }
    let mut centroids = init_centroids(vectors, n, dim, nlist, seed);
    let mut assign = vec![0u32; n];

    for _iter in 0..max_iter {
        let mut changed = false;
        // Assignment step.
        for i in 0..n {
            let v = &vectors[i * dim..i * dim + dim];
            let (best, _d) = nearest(v, &centroids, nlist, dim);
            if assign[i] != best as u32 {
                assign[i] = best as u32;
                changed = true;
            }
        }
        // Update step: mean per cluster (f64 accumulator for stable summation).
        let mut sums = vec![0f64; nlist * dim];
        let mut counts = vec![0u32; nlist];
        for i in 0..n {
            let c = assign[i] as usize;
            counts[c] += 1;
            let v = &vectors[i * dim..i * dim + dim];
            let base = c * dim;
            for k in 0..dim {
                sums[base + k] += v[k] as f64;
            }
        }
        for c in 0..nlist {
            if counts[c] > 0 {
                let inv = 1.0 / (counts[c] as f64);
                let base = c * dim;
                for k in 0..dim {
                    centroids[base + k] = (sums[base + k] * inv) as f32;
                }
            }
        }
        // Empty-cluster reseed: farthest point from its centroid, tie → lowest idx.
        reseed_empty(vectors, n, dim, nlist, &counts, &assign, &mut centroids);
        if !changed {
            break;
        }
    }
    centroids
}

/// Deterministically refill empty clusters. For each empty cluster (ascending
/// id), steal the single not-yet-stolen point with the max sq-dist to its own
/// centroid (tie → lowest point index) and seat the empty centroid on it.
fn reseed_empty(
    vectors: &[i8],
    n: usize,
    dim: usize,
    nlist: usize,
    counts: &[u32],
    assign: &[u32],
    centroids: &mut [f32],
) {
    let mut stolen = vec![false; n];
    for c in 0..nlist {
        if counts[c] != 0 {
            continue;
        }
        let mut far_pt = usize::MAX;
        let mut far_d = -1f64;
        for i in 0..n {
            if stolen[i] {
                continue;
            }
            let v = &vectors[i * dim..i * dim + dim];
            let own = assign[i] as usize;
            let d = sq_dist_i8_f32(v, &centroids[own * dim..own * dim + dim]);
            if d > far_d {
                far_d = d;
                far_pt = i;
            }
        }
        if far_pt != usize::MAX {
            stolen[far_pt] = true;
            let v = &vectors[far_pt * dim..far_pt * dim + dim];
            for k in 0..dim {
                centroids[c * dim + k] = v[k] as f32;
            }
        }
    }
}

/// Assign each int8 vector to its nearest centroid cell. Tie → lower index.
pub fn assign(
    vectors: &[i8],
    n: usize,
    dim: usize,
    centroids: &[f32],
    nlist: usize,
) -> Vec<u32> {
    let mut out = vec![0u32; n];
    for i in 0..n {
        let v = &vectors[i * dim..i * dim + dim];
        out[i] = nearest(v, centroids, nlist, dim).0 as u32;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(n: usize, dim: usize, seed: u32) -> Vec<i8> {
        let mut r = crate::rng::Mulberry32::new(seed);
        (0..n * dim)
            .map(|_| ((r.next_f64() * 255.0) as i32 - 128) as i8)
            .collect()
    }

    #[test]
    fn train_is_byte_identical_across_runs() {
        let v = fixture(400, 32, 7);
        let a = train(&v, 400, 32, 16, 123, 15);
        let b = train(&v, 400, 32, 16, 123, 15);
        assert_eq!(a, b, "k-means must be deterministic for same seed");
    }

    #[test]
    fn assign_matches_train_internal_assignment() {
        let v = fixture(300, 32, 9);
        let c = train(&v, 300, 32, 12, 5, 20);
        let asg = assign(&v, 300, 32, &c, 12);
        assert_eq!(asg.len(), 300);
        assert!(asg.iter().all(|&x| (x as usize) < 12));
    }
}
