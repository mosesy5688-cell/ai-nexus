#!/usr/bin/env node
// IVF-PQ bake-phase benchmark (Rust FFI). Mirrors the spike workload:
//   trainKmeans  nlist=1024, ~150K int8 dim=768, 20 iter
//   trainPqCodebook M=48 (256/sub, dsub=16) on the same 150K sample
//   pqEncode 550K
// Goal: ivf-pq-build phase comfortably < bake 330min/6GB budget (JS baseline was
// ~97min for coarse k-means alone @550K-spike). Usage: node bench-ivf-pq.mjs [scale]
// scale<1 shrinks N for a quick smoke (extrapolation note printed).

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const rust = require('../../rust/ivf-pq/ivf-pq-rust.node');
const js = await import('./lib/ivf-pq-js-fallback.js');

const SCALE = parseFloat(process.argv[2] || '1');
const DIM = 768, NLIST = 1024, M = 48, NBITS = 8, SEED = 2026, ITER = 20;
const N_TRAIN = Math.round(150000 * SCALE);
const N_ENCODE = Math.round(550000 * SCALE);

function makeVectors(n, dim, seed) {
  const rng = js.mulberry32(seed);
  const b = Buffer.allocUnsafe(n * dim);
  for (let i = 0; i < b.length; i++) b[i] = Math.floor(rng() * 256) & 0xff;
  return b;
}

console.log(`[bench] scale=${SCALE} N_train=${N_TRAIN} N_encode=${N_ENCODE} dim=${DIM} nlist=${NLIST} M=${M} iter=${ITER}`);
const memMB = () => (process.memoryUsage().rss / 1048576).toFixed(0);

console.log('[bench] allocating training sample...');
const train = makeVectors(N_TRAIN, DIM, 11);
console.log(`[bench] sample ready, RSS=${memMB()}MB`);

let t = Date.now();
const centroids = rust.trainKmeans(train, N_TRAIN, DIM, NLIST, SEED, ITER);
const tKmeans = (Date.now() - t) / 1000;
console.log(`[bench] trainKmeans: ${tKmeans.toFixed(1)}s  (centroids ${centroids.length} B)  RSS=${memMB()}MB`);

t = Date.now();
const codebook = rust.trainPqCodebook(train, N_TRAIN, DIM, M, NBITS, SEED, ITER);
const tPq = (Date.now() - t) / 1000;
console.log(`[bench] trainPqCodebook: ${tPq.toFixed(1)}s  (codebook ${codebook.length} B)  RSS=${memMB()}MB`);

console.log('[bench] allocating encode set...');
const encodeSet = makeVectors(N_ENCODE, DIM, 22);
t = Date.now();
const codes = rust.pqEncode(encodeSet, N_ENCODE, DIM, codebook, M);
const tEnc = (Date.now() - t) / 1000;
console.log(`[bench] pqEncode ${N_ENCODE}: ${tEnc.toFixed(1)}s  (codes ${codes.length} B)  RSS=${memMB()}MB`);

t = Date.now();
const asg = rust.assignCentroids(encodeSet, N_ENCODE, DIM, centroids, NLIST);
const tAsg = (Date.now() - t) / 1000;
console.log(`[bench] assignCentroids ${N_ENCODE}: ${tAsg.toFixed(1)}s  (${asg.length} cells)  RSS=${memMB()}MB`);

const total = tKmeans + tPq + tEnc + tAsg;
console.log(`\n[bench] TOTAL ivf-pq-build (Rust): ${total.toFixed(1)}s = ${(total / 60).toFixed(2)} min  peakRSS≈${memMB()}MB`);
if (SCALE < 1) console.log(`[bench] NOTE: scale<1 — kmeans/pq train ~linear in N_train, encode ~linear in N_encode; extrapolate ÷${SCALE}.`);
