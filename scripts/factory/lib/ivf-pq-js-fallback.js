// IVF-PQ JS fallback (P1) + PARITY ORACLE — PQ / ADC / cosine + re-export.
//
// Pure-JS implementations of the ivf-pq-rust crate, algorithmically IDENTICAL to
// the Rust (same mulberry32 PRNG via core, same Fisher-Yates init, same
// lowest-index tie-break, same per-subspace seed = (seed+m)>>>0, same f64
// distance accumulation). This is BOTH the P1 bake fallback AND the parity oracle
// that scripts/factory/verify-ivf-pq-parity.mjs asserts the Rust output against.
// SERVE re-implements ADC/cosine in TS (ticket#3) — this is producer-side only.
//
// Shared PRNG/buffer/k-means primitives live in ivf-pq-fallback-core.js (CES
// 250-line split). This file is the SINGLE public entry point: it re-exports the
// core's trainKmeans/assignCentroids/mulberry32 so callers import one module.

import {
  KSUB, mulberry32, asInt8, f32FromBuffer, bufferFromF32, sqDist,
  shuffledIndices, trainKmeans, assignCentroids,
} from './ivf-pq-fallback-core.js';

/** Nearest sub-centroid (of KSUB) for a dsub-dim subvector. Tie -> lower index. */
function nearestSub(subs, so, book, dsub) {
  let best = 0;
  let bestD = Infinity;
  for (let c = 0; c < KSUB; c++) {
    const d = sqDist(subs, so, book, c * dsub, dsub);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

/** Train one subspace codebook (KSUB x dsub) over n x dsub f32 `subs`. */
function trainSubspace(subs, n, dsub, seed, maxIter) {
  const book = new Float32Array(KSUB * dsub);
  const idx = shuffledIndices(n, KSUB, seed);
  for (let c = 0; c < KSUB; c++) {
    const src = n > 0 ? idx[c % n] : 0;
    for (let k = 0; k < dsub; k++) book[c * dsub + k] = subs[src * dsub + k];
  }
  if (n === 0) return book;
  const assign = new Uint32Array(n);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      const a = nearestSub(subs, i * dsub, book, dsub);
      if (assign[i] !== a) { assign[i] = a; changed = true; }
    }
    const sums = new Float64Array(KSUB * dsub);
    const counts = new Uint32Array(KSUB);
    for (let i = 0; i < n; i++) {
      const c = assign[i];
      counts[c]++;
      for (let k = 0; k < dsub; k++) sums[c * dsub + k] += subs[i * dsub + k];
    }
    for (let c = 0; c < KSUB; c++) {
      if (counts[c] > 0) {
        const inv = 1 / counts[c];
        for (let k = 0; k < dsub; k++) book[c * dsub + k] = Math.fround(sums[c * dsub + k] * inv);
      }
    }
    if (!changed) break;
  }
  return book;
}

/** trainPqCodebook — M subspaces, nbits=8. Returns M*256*dsub f32 Buffer. */
function trainPqCodebook(int8Vectors, n, dim, m, nbits, seed, maxIter) {
  if (nbits !== 8) throw new Error('trainPqCodebook: nbits must be 8 (Phase A)');
  if (dim % m !== 0) throw new Error('trainPqCodebook: dim must be divisible by m');
  const v = asInt8(int8Vectors);
  const dsub = dim / m;
  const codebook = new Float32Array(m * KSUB * dsub);
  const subs = new Float32Array(n * dsub);
  for (let mi = 0; mi < m; mi++) {
    const off = mi * dsub;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < dsub; k++) subs[i * dsub + k] = v[i * dim + off + k];
    }
    const book = trainSubspace(subs, n, dsub, (seed + mi) >>> 0, maxIter);
    codebook.set(book, mi * KSUB * dsub);
  }
  return bufferFromF32(codebook);
}

/** pqEncode — int8 vectors -> n*M u8 codes Buffer. */
function pqEncode(int8Vectors, n, dim, codebookBuf, m) {
  if (dim % m !== 0) throw new Error('pqEncode: dim must be divisible by m');
  const v = asInt8(int8Vectors);
  const codebook = f32FromBuffer(codebookBuf);
  const dsub = dim / m;
  const codes = Buffer.allocUnsafe(n * m);
  const sub = new Float32Array(dsub);
  for (let i = 0; i < n; i++) {
    for (let mi = 0; mi < m; mi++) {
      const off = mi * dsub;
      for (let k = 0; k < dsub; k++) sub[k] = v[i * dim + off + k];
      const cbBase = mi * KSUB * dsub;
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < KSUB; c++) {
        let s = 0;
        for (let k = 0; k < dsub; k++) {
          const d = sub[k] - codebook[cbBase + c * dsub + k];
          s += d * d;
        }
        if (s < bestD) { bestD = s; best = c; }
      }
      codes[i * m + mi] = best;
    }
  }
  return codes;
}

/** adcLut — M*256 squared-L2 LUT for an f32 query. Returns Float32 LE Buffer. */
function adcLut(queryF32, codebookBuf, m, nbits) {
  if (nbits !== 8) throw new Error('adcLut: nbits must be 8 (Phase A)');
  const codebook = f32FromBuffer(codebookBuf);
  const dsub = codebook.length / (m * KSUB);
  const lut = new Float32Array(m * KSUB);
  for (let mi = 0; mi < m; mi++) {
    const qOff = mi * dsub;
    const cbBase = mi * KSUB * dsub;
    for (let c = 0; c < KSUB; c++) {
      let s = 0;
      for (let k = 0; k < dsub; k++) {
        const d = queryF32[qOff + k] - codebook[cbBase + c * dsub + k];
        s += d * d;
      }
      lut[mi * KSUB + c] = Math.fround(s);
    }
  }
  return bufferFromF32(lut);
}

/** adcScore — approximate squared-L2 of one PQ code under the LUT. O(M). */
function adcScore(lutBuf, pqCode, m) {
  const lut = f32FromBuffer(lutBuf);
  let s = 0;
  for (let mi = 0; mi < m; mi++) s += lut[mi * KSUB + pqCode[mi]];
  return s;
}

/** cosineF32Int8 — asymmetric f32 query vs int8 db cosine (serve rerank ref). */
function cosineF32Int8(queryF32, dbInt8, scale, dim) {
  const db = asInt8(dbInt8);
  let dot = 0, nq = 0, nd = 0;
  for (let k = 0; k < dim; k++) {
    const q = queryF32[k];
    const d = db[k] * scale;
    dot += q * d;
    nq += q * q;
    nd += d * d;
  }
  if (nq === 0 || nd === 0) return 0;
  return dot / (Math.sqrt(nq) * Math.sqrt(nd));
}

export {
  mulberry32,
  trainKmeans,
  assignCentroids,
  assignCentroids as batchAssign,
  trainPqCodebook,
  pqEncode,
  pqEncode as batchPqEncode,
  adcLut,
  adcScore,
  cosineF32Int8,
};
