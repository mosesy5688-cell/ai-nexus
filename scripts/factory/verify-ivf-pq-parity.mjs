#!/usr/bin/env node
// IVF-PQ parity + determinism gate (NODE-runnable — the load-bearing check).
//
// CI runs `napi build`, NOT `cargo test`, so the Rust #[test] suite is NOT a CI
// gate (lesson from #2132/#2136). This script IS the gate: it loads the built
// ivf-pq-rust.node and asserts Rust == JS-fallback on a small FIXED fixture:
//   1. trainKmeans   : byte-identical centroids (determinism + parity).
//   2. assignCentroids: identical cell ids.
//   3. trainPqCodebook: byte-identical codebook.
//   4. pqEncode      : identical codes.
//   5. adcLut/adcScore: identical within tolerance.
//   6. cosineF32Int8 : identical within tolerance.
//   7. Determinism   : trainKmeans/trainPqCodebook stable across two runs.
// If the .node is absent it runs JS-vs-JS (still asserts determinism) and warns.
//
// Usage: node scripts/factory/verify-ivf-pq-parity.mjs
// Exit 0 = pass, 1 = parity/determinism failure.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const js = await import('./lib/ivf-pq-js-fallback.js');

let rust = null;
try {
  rust = require('../../rust/ivf-pq/ivf-pq-rust.node');
} catch (e) {
  console.warn(`[parity] .node not loadable (${e.message.slice(0, 60)}) — running JS-vs-JS (determinism only).`);
}

// ---- fixed fixture ---------------------------------------------------------
const N = 600, DIM = 32, NLIST = 16, M = 4, NBITS = 8, SEED = 1234, ITER = 12;
function makeVectors(n, dim, seed) {
  const rng = js.mulberry32(seed);
  const b = Buffer.allocUnsafe(n * dim);
  for (let i = 0; i < n * dim; i++) b[i] = Math.floor(rng() * 256) & 0xff; // u8 -> read as i8
  return b;
}
const vectors = makeVectors(N, DIM, 7);
const query = new Float32Array(DIM);
{ const rng = js.mulberry32(99); for (let k = 0; k < DIM; k++) query[k] = (rng() - 0.5) * 4; }

let failures = 0;
const log = (ok, name, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
};
const bufEq = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const arrEq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---- 1. trainKmeans ---------------------------------------------------------
const jsCent = js.trainKmeans(vectors, N, DIM, NLIST, SEED, ITER);
const jsCent2 = js.trainKmeans(vectors, N, DIM, NLIST, SEED, ITER);
log(bufEq(jsCent, jsCent2), 'determinism: JS trainKmeans stable across runs');
if (rust) {
  const rCent = rust.trainKmeans(vectors, N, DIM, NLIST, SEED, ITER);
  const rCent2 = rust.trainKmeans(vectors, N, DIM, NLIST, SEED, ITER);
  log(bufEq(rCent, rCent2), 'determinism: Rust trainKmeans byte-identical across runs');
  log(bufEq(rCent, jsCent), 'parity: trainKmeans Rust == JS (byte-identical centroids)');
}

// ---- 2. assignCentroids -----------------------------------------------------
const jsAsg = js.assignCentroids(vectors, N, DIM, jsCent, NLIST);
if (rust) {
  const rAsg = rust.assignCentroids(vectors, N, DIM, jsCent, NLIST);
  log(arrEq(Array.from(rAsg), Array.from(jsAsg)), 'parity: assignCentroids Rust == JS (identical cell ids)');
}

// ---- 3. trainPqCodebook -----------------------------------------------------
const jsCb = js.trainPqCodebook(vectors, N, DIM, M, NBITS, SEED, ITER);
const jsCb2 = js.trainPqCodebook(vectors, N, DIM, M, NBITS, SEED, ITER);
log(bufEq(jsCb, jsCb2), 'determinism: JS trainPqCodebook stable across runs');
if (rust) {
  const rCb = rust.trainPqCodebook(vectors, N, DIM, M, NBITS, SEED, ITER);
  const rCb2 = rust.trainPqCodebook(vectors, N, DIM, M, NBITS, SEED, ITER);
  log(bufEq(rCb, rCb2), 'determinism: Rust trainPqCodebook byte-identical across runs');
  log(bufEq(rCb, jsCb), 'parity: trainPqCodebook Rust == JS (byte-identical codebook)');
}

// ---- 4. pqEncode ------------------------------------------------------------
const jsCodes = js.pqEncode(vectors, N, DIM, jsCb, M);
if (rust) {
  const rCodes = rust.pqEncode(vectors, N, DIM, jsCb, M);
  log(bufEq(rCodes, jsCodes), 'parity: pqEncode Rust == JS (identical codes)');
}

// ---- 5. adcLut + adcScore ---------------------------------------------------
const jsLut = js.adcLut(query, jsCb, M, NBITS);
const code0 = jsCodes.subarray(0, M);
const jsScore = js.adcScore(jsLut, code0, M);
if (rust) {
  const rLut = rust.adcLut(query, jsCb, M, NBITS);
  log(bufEq(rLut, jsLut), 'parity: adcLut Rust == JS (byte-identical LUT)');
  const rScore = rust.adcScore(jsLut, code0, M);
  log(Math.abs(rScore - jsScore) < 1e-9, 'parity: adcScore Rust == JS', `Δ=${Math.abs(rScore - jsScore).toExponential(2)}`);
}

// ---- 6. cosineF32Int8 -------------------------------------------------------
const db0 = vectors.subarray(0, DIM);
const scale = 1 / 127;
const jsCos = js.cosineF32Int8(query, db0, scale, DIM);
if (rust) {
  const rCos = rust.cosineF32Int8(query, db0, scale, DIM);
  log(Math.abs(rCos - jsCos) < 1e-12, 'parity: cosineF32Int8 Rust == JS', `Δ=${Math.abs(rCos - jsCos).toExponential(2)}`);
}

console.log(`\n${failures === 0 ? 'ALL PARITY/DETERMINISM CHECKS PASSED' : failures + ' CHECK(S) FAILED'}${rust ? '' : ' (JS-only — .node not present)'}`);
process.exit(failures === 0 ? 0 : 1);
