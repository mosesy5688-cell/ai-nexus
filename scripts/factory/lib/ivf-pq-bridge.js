// IVF-PQ FFI bridge wrappers (Rust primary -> JS fallback).
//
// rust-bridge.js sits at the CES 250-line ceiling, so the IVF-PQ wrappers live
// here (its loader entry stays in rust-bridge.js, which calls setIvfPqModule).
// Each wrapper follows the house pattern: if the Rust module loaded use it, else
// fall through to the algorithmically-IDENTICAL JS fallback (P1 + parity oracle).
// PRODUCER/BAKE-side only — the serve isolate reimplements ADC/cosine in TS.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let _ivfPq = null;
const js = () => require('./ivf-pq-js-fallback.js');

/** Loader hook called by rust-bridge.initRustBridge(). */
export function setIvfPqModule(mod) { _ivfPq = mod; }

/** True when the Rust ivf-pq native module is loaded. */
export function isIvfPqRustLoaded() { return _ivfPq !== null; }

/** Train IVF coarse quantizer. DETERMINISTIC. Returns nlist*dim f32 Buffer. */
export function trainKmeansFFI(int8Vectors, n, dim, nlist, seed, maxIter) {
  if (_ivfPq) return _ivfPq.trainKmeans(int8Vectors, n, dim, nlist, seed, maxIter);
  return js().trainKmeans(int8Vectors, n, dim, nlist, seed, maxIter);
}

/** Assign each int8 vector to its nearest centroid cell. Returns Uint32Array. */
export function assignCentroidsFFI(int8Vectors, n, dim, centroids, nlist) {
  if (_ivfPq) return _ivfPq.assignCentroids(int8Vectors, n, dim, centroids, nlist);
  return js().assignCentroids(int8Vectors, n, dim, centroids, nlist);
}

/** Train PQ codebook. DETERMINISTIC. nbits=8. Returns M*256*dsub f32 Buffer. */
export function trainPqCodebookFFI(int8Vectors, n, dim, m, nbits, seed, maxIter) {
  if (_ivfPq) return _ivfPq.trainPqCodebook(int8Vectors, n, dim, m, nbits, seed, maxIter);
  return js().trainPqCodebook(int8Vectors, n, dim, m, nbits, seed, maxIter);
}

/** PQ-encode int8 vectors -> n*M u8 codes Buffer. */
export function pqEncodeFFI(int8Vectors, n, dim, codebook, m) {
  if (_ivfPq) return _ivfPq.pqEncode(int8Vectors, n, dim, codebook, m);
  return js().pqEncode(int8Vectors, n, dim, codebook, m);
}

/** Build ADC LUT (M*256 squared-L2) for an f32 query. Returns f32 Buffer (ref). */
export function adcLutFFI(queryF32, codebook, m, nbits) {
  if (_ivfPq) return _ivfPq.adcLut(queryF32, codebook, m, nbits);
  return js().adcLut(queryF32, codebook, m, nbits);
}

/** Approximate squared-L2 distance of one PQ code under the LUT (O(M), ref). */
export function adcScoreFFI(lut, pqCode, m) {
  if (_ivfPq) return _ivfPq.adcScore(lut, pqCode, m);
  return js().adcScore(lut, pqCode, m);
}

/** Asymmetric cosine: f32 query vs int8 db vector (serve rerank parity ref). */
export function cosineF32Int8FFI(queryF32, dbInt8, scale, dim) {
  if (_ivfPq) return _ivfPq.cosineF32Int8(queryF32, dbInt8, scale, dim);
  return js().cosineF32Int8(queryF32, dbInt8, scale, dim);
}
