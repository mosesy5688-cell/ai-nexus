//! Asymmetric cosine: f32 query vs int8 DB vector — reference for serve rerank.
//!
//! The exact-rerank tier (design §4 cluster-rerank.ts: S = exact int8 cosine,
//! entity-granular/honest, not centroid) computes cosine(query_f32, db_int8)
//! where the int8 DB vector is the quantized embedding. `scale` is the
//! quantization scale: the dequantized DB component = db[i] * scale. Because
//! cosine normalizes both vectors, `scale` cancels out for a single vector, but
//! it is kept in the signature so the reference matches whatever the serve TS
//! does and so callers can pass the gen's scale explicitly (a no-op for the
//! ratio, but documents intent and guards against future per-dim scales).
//! Returns cosine similarity in [-1, 1]; 0 when either norm is 0.

pub fn cosine_f32_int8(query: &[f32], db: &[i8], scale: f64, dim: usize) -> f64 {
    let mut dot = 0f64;
    let mut nq = 0f64;
    let mut nd = 0f64;
    for k in 0..dim {
        let q = query[k] as f64;
        let d = (db[k] as f64) * scale;
        dot += q * d;
        nq += q * q;
        nd += d * d;
    }
    if nq == 0.0 || nd == 0.0 {
        return 0.0;
    }
    dot / (nq.sqrt() * nd.sqrt())
}
