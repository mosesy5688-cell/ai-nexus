//! Deterministic PRNG — exact port of JS `mulberry32`.
//!
//! The producer (ivf-pq-js-fallback.js) and this crate MUST emit byte-identical
//! training output for the same (input, seed). That FROZEN-quantizer guarantee
//! rests entirely on this PRNG being bit-for-bit identical to the JS version, so
//! the algorithm below mirrors the canonical mulberry32 reference using wrapping
//! u32 arithmetic and `Math.imul`-equivalent 32-bit multiply.

/// Mulberry32 generator. `state` advances on every `next_u32` / `next_f64`.
pub struct Mulberry32 {
    state: u32,
}

impl Mulberry32 {
    #[inline]
    pub fn new(seed: u32) -> Self {
        Mulberry32 { state: seed }
    }

    /// One mulberry32 step → raw u32 (the `(t ^ t>>>14) >>> 0` value before /2^32).
    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        // a = a + 0x6D2B79F5 | 0
        self.state = self.state.wrapping_add(0x6D2B_79F5);
        let a = self.state;
        // t = Math.imul(a ^ a>>>15, 1 | a)
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        // t = t + Math.imul(t ^ t>>>7, 61 | t) ^ t
        t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
        // (t ^ t>>>14) >>> 0
        t ^ (t >> 14)
    }

    /// Float in [0, 1) — exactly `((t ^ t>>>14) >>> 0) / 4294967296`.
    #[inline]
    pub fn next_f64(&mut self) -> f64 {
        (self.next_u32() as f64) / 4294967296.0
    }

    /// Uniform integer in [0, n) via floor(next_f64 * n). Mirrors
    /// `Math.floor(rng() * n)` in JS (the only int-draw form the fallback uses).
    #[inline]
    pub fn next_below(&mut self, n: usize) -> usize {
        let v = (self.next_f64() * (n as f64)).floor() as usize;
        if v >= n {
            n - 1
        } else {
            v
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_sequence() {
        let mut a = Mulberry32::new(42);
        let mut b = Mulberry32::new(42);
        for _ in 0..1000 {
            assert_eq!(a.next_u32(), b.next_u32());
        }
    }

    #[test]
    fn first_draws_match_js_reference() {
        // Captured from the canonical JS mulberry32(42) implementation
        // (node -e '...mulberry32(42)...'). These constants are the parity oracle.
        let mut r = Mulberry32::new(42);
        let expect_u32 = [2581720956u32, 1925393290, 3661312704, 2876485805, 750819978];
        for (i, &e) in expect_u32.iter().enumerate() {
            let got = r.next_u32();
            assert_eq!(got, e, "u32 draw {} mismatch", i);
        }
        let mut rf = Mulberry32::new(42);
        let expect_f = [
            0.6011037519201636f64,
            0.44829055899754167,
            0.8524657934904099,
            0.6697340414393693,
            0.17481389874592423,
        ];
        for (i, &e) in expect_f.iter().enumerate() {
            assert!((rf.next_f64() - e).abs() < 1e-15, "f64 draw {} mismatch", i);
        }
    }
}
