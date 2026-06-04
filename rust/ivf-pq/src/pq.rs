//! Product-quantization codebook training + encoding (seed-deterministic).
//!
//! M subquantizers, each a 2^nbits-entry k-means over a dsub=dim/M slice of the
//! widened-f32 vector. nbits is fixed at 8 (256 centroids/subspace) for Phase A.
//! Per-subspace seed = seed.wrapping_add(m) so subspaces don't all draw the same
//! init indices; this exact derivation is mirrored in ivf-pq-js-fallback.js.
//!
//! Codebook layout (row-major f32): [M][2^nbits][dsub].
//! Encoded code layout (u8): [n][M].

use crate::rng::Mulberry32;

const KSUB: usize = 256; // 2^nbits, nbits=8 (Phase A locked).

/// Squared L2 in f64 (promote f32 components) to byte-match the JS fallback.
#[inline]
fn sq_dist(a: &[f32], b: &[f32]) -> f64 {
    let mut s = 0f64;
    for k in 0..a.len() {
        let d = (a[k] as f64) - (b[k] as f64);
        s += d * d;
    }
    s
}

/// Nearest sub-centroid (of KSUB) for a dsub-dim subvector. Tie → lower index.
#[inline]
fn nearest_sub(sub: &[f32], book: &[f32], dsub: usize) -> u8 {
    let mut best = 0usize;
    let mut best_d = f64::INFINITY;
    for c in 0..KSUB {
        let cen = &book[c * dsub..c * dsub + dsub];
        let d = sq_dist(sub, cen);
        if d < best_d {
            best_d = d;
            best = c;
        }
    }
    best as u8
}

/// Train one subspace codebook (KSUB centroids × dsub) over `subs` (n × dsub).
fn train_subspace(subs: &[f32], n: usize, dsub: usize, seed: u32, max_iter: u32) -> Vec<f32> {
    let mut book = vec![0f32; KSUB * dsub];
    // Fisher-Yates partial shuffle init (mirrors kmeans init / JS fallback).
    let mut idx: Vec<usize> = (0..n).collect();
    let mut rng = Mulberry32::new(seed);
    let pick = KSUB.min(n);
    for i in 0..pick {
        let j = i + rng.next_below(n - i);
        idx.swap(i, j);
    }
    for c in 0..KSUB {
        let src = if n > 0 { idx[c % n] } else { 0 };
        let s = &subs[src * dsub..src * dsub + dsub];
        book[c * dsub..c * dsub + dsub].copy_from_slice(s);
    }
    if n == 0 {
        return book;
    }
    let mut assign = vec![0u32; n];
    for _ in 0..max_iter {
        let mut changed = false;
        for i in 0..n {
            let a = nearest_sub(&subs[i * dsub..i * dsub + dsub], &book, dsub) as u32;
            if assign[i] != a {
                assign[i] = a;
                changed = true;
            }
        }
        let mut sums = vec![0f64; KSUB * dsub];
        let mut counts = vec![0u32; KSUB];
        for i in 0..n {
            let c = assign[i] as usize;
            counts[c] += 1;
            let base = c * dsub;
            let s = &subs[i * dsub..i * dsub + dsub];
            for k in 0..dsub {
                sums[base + k] += s[k] as f64;
            }
        }
        for c in 0..KSUB {
            if counts[c] > 0 {
                let inv = 1.0 / (counts[c] as f64);
                for k in 0..dsub {
                    book[c * dsub + k] = (sums[c * dsub + k] * inv) as f32;
                }
            }
        }
        if !changed {
            break;
        }
    }
    book
}

/// Train the full codebook. Returns f32 buffer of M*KSUB*dsub.
pub fn train_codebook(
    vectors: &[i8],
    n: usize,
    dim: usize,
    m: usize,
    seed: u32,
    max_iter: u32,
) -> Vec<f32> {
    let dsub = dim / m;
    let mut codebook = vec![0f32; m * KSUB * dsub];
    // Reusable subspace scratch (n × dsub), widened to f32.
    let mut subs = vec![0f32; n * dsub];
    for mi in 0..m {
        let off = mi * dsub;
        for i in 0..n {
            let v = &vectors[i * dim..i * dim + dim];
            for k in 0..dsub {
                subs[i * dsub + k] = v[off + k] as f32;
            }
        }
        let book = train_subspace(&subs, n, dsub, seed.wrapping_add(mi as u32), max_iter);
        let cb_base = mi * KSUB * dsub;
        codebook[cb_base..cb_base + KSUB * dsub].copy_from_slice(&book);
    }
    codebook
}

/// Encode int8 vectors → u8 codes (n × M). Nearest sub-centroid per subspace.
pub fn encode(vectors: &[i8], n: usize, dim: usize, codebook: &[f32], m: usize) -> Vec<u8> {
    let dsub = dim / m;
    let mut codes = vec![0u8; n * m];
    let mut sub = vec![0f32; dsub];
    for i in 0..n {
        let v = &vectors[i * dim..i * dim + dim];
        for mi in 0..m {
            let off = mi * dsub;
            for k in 0..dsub {
                sub[k] = v[off + k] as f32;
            }
            let book = &codebook[mi * KSUB * dsub..(mi + 1) * KSUB * dsub];
            codes[i * m + mi] = nearest_sub(&sub, book, dsub);
        }
    }
    codes
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
    fn codebook_is_deterministic() {
        let v = fixture(500, 32, 3);
        let a = train_codebook(&v, 500, 32, 4, 11, 10);
        let b = train_codebook(&v, 500, 32, 4, 11, 10);
        assert_eq!(a, b, "PQ codebook must be deterministic");
        assert_eq!(a.len(), 4 * KSUB * 8);
    }

    #[test]
    fn encode_shape_and_range() {
        let v = fixture(500, 32, 3);
        let cb = train_codebook(&v, 500, 32, 4, 11, 10);
        let codes = encode(&v, 500, 32, &cb, 4);
        assert_eq!(codes.len(), 500 * 4);
    }
}
