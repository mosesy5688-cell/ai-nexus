//! IVF-PQ Phase A — bake/PRODUCER-side NAPI crate.
//!
//! Scope: this crate runs ONLY at bake time (k-means coarse-quantizer training,
//! PQ codebook training, 550K encode) and as the canonical ADC/cosine reference
//! oracle. The SERVE side runs in a Cloudflare Worker V8 isolate and CANNOT load
//! .node — ticket#3 reimplements ADC/cosine in pure TS (pq-codec.ts), parity-
//! tested against THIS crate. See IVF_PQ_DESIGN_2026-06-05.md §v2.
//!
//! All training entry points are seed-DETERMINISTIC (mulberry32, no Math.random,
//! no nondeterministic HashMap iteration) → byte-identical output across runs for
//! the same (input, seed). That is the FROZEN-quantizer guarantee.
//!
//! Binary FFI conventions:
//!   - int8 vectors      : Buffer of n*dim bytes, reinterpreted as i8.
//!   - centroids/codebook: Buffer of f32 little-endian bytes (row-major).
//!   - adc LUT           : Buffer of f32 little-endian bytes (M*256).
//!   - pq codes          : Buffer of u8 (n*M, or M for a single code).
//!   - query             : Float32Array (dim, or M*dsub).
//!   - cell assignments  : Uint32Array (n).

use napi::bindgen_prelude::*;
use napi_derive::napi;

mod adc;
mod cosine;
mod kmeans;
mod pq;
mod rng;

// ---- byte <-> typed helpers -------------------------------------------------

/// Reinterpret a Buffer's bytes as &[i8] (zero-copy; int8 vectors).
#[inline]
fn as_i8(buf: &Buffer) -> &[i8] {
    let b: &[u8] = buf.as_ref();
    unsafe { std::slice::from_raw_parts(b.as_ptr() as *const i8, b.len()) }
}

/// Decode a Buffer of f32 little-endian bytes into Vec<f32>.
fn f32_from_buffer(buf: &Buffer) -> Vec<f32> {
    let b: &[u8] = buf.as_ref();
    let n = b.len() / 4;
    let mut out = vec![0f32; n];
    for i in 0..n {
        out[i] = f32::from_le_bytes([b[4 * i], b[4 * i + 1], b[4 * i + 2], b[4 * i + 3]]);
    }
    out
}

/// Encode &[f32] into a Buffer of little-endian bytes.
fn buffer_from_f32(v: &[f32]) -> Buffer {
    let mut out = Vec::with_capacity(v.len() * 4);
    for &x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    Buffer::from(out)
}

// ---- k-means coarse quantizer ----------------------------------------------

/// Train the IVF coarse quantizer. DETERMINISTIC.
/// `int8_vectors`: n*dim int8 bytes. Returns nlist*dim f32 centroids (Buffer).
#[napi]
pub fn train_kmeans(
    int8_vectors: Buffer,
    n: u32,
    dim: u32,
    nlist: u32,
    seed: u32,
    max_iter: u32,
) -> Result<Buffer> {
    let (n, dim, nlist) = (n as usize, dim as usize, nlist as usize);
    if int8_vectors.len() < n * dim {
        return Err(Error::from_reason(format!(
            "trainKmeans: buffer {} < n*dim {}",
            int8_vectors.len(),
            n * dim
        )));
    }
    let c = kmeans::train(as_i8(&int8_vectors), n, dim, nlist, seed, max_iter);
    Ok(buffer_from_f32(&c))
}

/// Assign each int8 vector to its nearest centroid cell. Returns Uint32Array(n).
#[napi]
pub fn assign_centroids(
    int8_vectors: Buffer,
    n: u32,
    dim: u32,
    centroids: Buffer,
    nlist: u32,
) -> Result<Uint32Array> {
    let (n, dim, nlist) = (n as usize, dim as usize, nlist as usize);
    let cen = f32_from_buffer(&centroids);
    if cen.len() < nlist * dim {
        return Err(Error::from_reason("assignCentroids: centroids too small"));
    }
    let out = kmeans::assign(as_i8(&int8_vectors), n, dim, &cen, nlist);
    Ok(Uint32Array::new(out))
}

/// Batch assign — alias of assignCentroids (kept for bake-throughput call sites
/// that want an explicit batch name; same single-pass O(n*nlist*dim) kernel).
#[napi]
pub fn batch_assign(
    int8_vectors: Buffer,
    n: u32,
    dim: u32,
    centroids: Buffer,
    nlist: u32,
) -> Result<Uint32Array> {
    assign_centroids(int8_vectors, n, dim, centroids, nlist)
}

// ---- PQ codebook + encode ---------------------------------------------------

/// Train the PQ codebook. DETERMINISTIC. `m` subquantizers, nbits=8 (256/sub).
/// dsub = dim/m. Returns m*256*dsub f32 (Buffer). `nbits` accepted for surface
/// stability but MUST be 8 (Phase A locked); other values are rejected.
#[napi]
pub fn train_pq_codebook(
    int8_vectors: Buffer,
    n: u32,
    dim: u32,
    m: u32,
    nbits: u32,
    seed: u32,
    max_iter: u32,
) -> Result<Buffer> {
    if nbits != 8 {
        return Err(Error::from_reason("trainPqCodebook: nbits must be 8 (Phase A)"));
    }
    let (n, dim, m) = (n as usize, dim as usize, m as usize);
    if dim % m != 0 {
        return Err(Error::from_reason("trainPqCodebook: dim must be divisible by m"));
    }
    if int8_vectors.len() < n * dim {
        return Err(Error::from_reason("trainPqCodebook: buffer < n*dim"));
    }
    let cb = pq::train_codebook(as_i8(&int8_vectors), n, dim, m, seed, max_iter);
    Ok(buffer_from_f32(&cb))
}

/// PQ-encode int8 vectors → n*M u8 codes (Buffer).
#[napi]
pub fn pq_encode(int8_vectors: Buffer, n: u32, dim: u32, codebook: Buffer, m: u32) -> Result<Buffer> {
    let (n, dim, m) = (n as usize, dim as usize, m as usize);
    if dim % m != 0 {
        return Err(Error::from_reason("pqEncode: dim must be divisible by m"));
    }
    let cb = f32_from_buffer(&codebook);
    let codes = pq::encode(as_i8(&int8_vectors), n, dim, &cb, m);
    Ok(Buffer::from(codes))
}

/// Batch PQ-encode — alias of pqEncode (explicit batch name for bake call sites).
#[napi]
pub fn batch_pq_encode(
    int8_vectors: Buffer,
    n: u32,
    dim: u32,
    codebook: Buffer,
    m: u32,
) -> Result<Buffer> {
    pq_encode(int8_vectors, n, dim, codebook, m)
}

// ---- ADC + cosine reference -------------------------------------------------

/// Build the ADC LUT (M*256 squared-L2) for an f32 query. Returns f32 Buffer.
#[napi]
pub fn adc_lut(query_f32: Float32Array, codebook: Buffer, m: u32, nbits: u32) -> Result<Buffer> {
    if nbits != 8 {
        return Err(Error::from_reason("adcLut: nbits must be 8 (Phase A)"));
    }
    let cb = f32_from_buffer(&codebook);
    let lut = adc::build_lut(query_f32.as_ref(), &cb, m as usize);
    Ok(buffer_from_f32(&lut))
}

/// Approximate (squared-L2) distance of one PQ code under the LUT. O(M).
/// LOWER = closer; candidate-gen takes the smallest scores.
#[napi]
pub fn adc_score(lut: Buffer, pq_code: Buffer, m: u32) -> Result<f64> {
    let l = f32_from_buffer(&lut);
    let code: &[u8] = pq_code.as_ref();
    if code.len() < m as usize {
        return Err(Error::from_reason("adcScore: code shorter than m"));
    }
    Ok(adc::score(&l, code, m as usize))
}

/// Asymmetric cosine: f32 query vs int8 DB vector (serve rerank parity ref).
/// Returns cosine similarity in [-1, 1].
#[napi]
pub fn cosine_f32_int8(query_f32: Float32Array, db_int8: Buffer, scale: f64, dim: u32) -> f64 {
    cosine::cosine_f32_int8(query_f32.as_ref(), as_i8(&db_int8), scale, dim as usize)
}
