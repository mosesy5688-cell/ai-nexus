//! Asymmetric Distance Computation (ADC) — reference implementation.
//!
//! Standard PQ ADC: precompute an M x KSUB lookup table of squared-L2 distances
//! between each subspace of the (f32) query and every sub-centroid, then a code's
//! approximate distance to the query = sum over subspaces of LUT[m][code[m]].
//! LOWER = closer. Candidate-gen takes the smallest adcScore values; the design's
//! Tier-2 then does exact int8 cosine rerank on the survivors (cosine.rs).
//!
//! This is the canonical reference that ticket#3's TS `pq-codec.ts` is
//! parity-tested against (codec-symmetry) and that the Node recall harness
//! (ticket#4) uses. dsub = dim/M is recovered from codebook.len()/(M*KSUB).

const KSUB: usize = 256; // nbits=8.

/// Build the M x KSUB squared-L2 LUT for a query. Returns f32 buffer (M*KSUB).
pub fn build_lut(query: &[f32], codebook: &[f32], m: usize) -> Vec<f32> {
    let total = codebook.len();
    let dsub = total / (m * KSUB);
    let mut lut = vec![0f32; m * KSUB];
    for mi in 0..m {
        let q_off = mi * dsub;
        let cb_base = mi * KSUB * dsub;
        for c in 0..KSUB {
            let cen = &codebook[cb_base + c * dsub..cb_base + c * dsub + dsub];
            // Accumulate in f64 then store as f32 (matches JS `Math.fround(s)`).
            let mut s = 0f64;
            for k in 0..dsub {
                let d = (query[q_off + k] as f64) - (cen[k] as f64);
                s += d * d;
            }
            lut[mi * KSUB + c] = s as f32;
        }
    }
    lut
}

/// Approximate squared-L2 distance of one PQ code under the LUT. O(M).
pub fn score(lut: &[f32], code: &[u8], m: usize) -> f64 {
    let mut s = 0f64;
    for mi in 0..m {
        s += lut[mi * KSUB + code[mi] as usize] as f64;
    }
    s
}
