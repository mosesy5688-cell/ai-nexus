// IVF-PQ JS fallback — SHARED CORE (PRNG, buffer helpers, k-means).
//
// Split out of ivf-pq-js-fallback.js to keep both files under the CES 250-line
// ceiling. Holds the determinism-critical primitives (mulberry32, Fisher-Yates
// init, lowest-index tie-break, f64 distance accumulation matching the Rust
// crate byte-for-byte) plus the coarse k-means + assign. PQ/ADC/cosine live in
// ivf-pq-js-fallback.js, which imports these. PRODUCER/BAKE-side only.

export const KSUB = 256; // 2^nbits, nbits=8 (Phase A locked).

/** mulberry32 — canonical reference PRNG; the determinism contract rests here. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Read int8 vectors out of a Buffer (signed bytes). */
export function asInt8(buf) {
  return new Int8Array(buf.buffer, buf.byteOffset, buf.length);
}

/** Float32 view over a Float32 LE Buffer (copy, alignment-safe). */
export function f32FromBuffer(buf) {
  const out = new Float32Array(buf.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

export function bufferFromF32(arr) {
  const b = Buffer.allocUnsafe(arr.length * 4);
  for (let i = 0; i < arr.length; i++) b.writeFloatLE(arr[i], i * 4);
  return b;
}

/** Squared L2 in f64 (matches the Rust crate's f64 accumulator for byte parity). */
export function sqDist(a, ao, b, bo, len) {
  let s = 0;
  for (let k = 0; k < len; k++) {
    const d = a[ao + k] - b[bo + k];
    s += d * d;
  }
  return s;
}

/** Fisher-Yates partial shuffle of [0,n); take first `pick` as init indices. */
export function shuffledIndices(n, pick, seed) {
  const idx = new Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  const rng = mulberry32(seed);
  const lim = Math.min(pick, n);
  for (let i = 0; i < lim; i++) {
    let j = i + Math.floor(rng() * (n - i));
    if (j >= n) j = n - 1; // mirror Rust next_below clamp
    const tmp = idx[i];
    idx[i] = idx[j];
    idx[j] = tmp;
  }
  return idx;
}

/** Nearest centroid for vector at offset `vo`. Tie -> lower index. */
export function nearest(v, vo, centroids, nlist, dim) {
  let best = 0;
  let bestD = Infinity;
  for (let c = 0; c < nlist; c++) {
    const d = sqDist(v, vo, centroids, c * dim, dim);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

/** Empty-cluster reseed: farthest unstolen point from its centroid (tie->low). */
function reseedEmpty(v, n, dim, nlist, counts, assign, centroids) {
  let stolen = null;
  for (let c = 0; c < nlist; c++) {
    if (counts[c] !== 0) continue;
    if (!stolen) stolen = new Uint8Array(n);
    let farPt = -1;
    let farD = -1;
    for (let i = 0; i < n; i++) {
      if (stolen[i]) continue;
      const own = assign[i];
      const d = sqDist(v, i * dim, centroids, own * dim, dim);
      if (d > farD) { farD = d; farPt = i; }
    }
    if (farPt >= 0) {
      stolen[farPt] = 1;
      for (let k = 0; k < dim; k++) centroids[c * dim + k] = v[farPt * dim + k];
    }
  }
}

/** trainKmeans — seed-deterministic Lloyd over int8 (widened f32). */
export function trainKmeans(int8Vectors, n, dim, nlist, seed, maxIter) {
  const v = asInt8(int8Vectors);
  const centroids = new Float32Array(nlist * dim);
  if (n === 0 || dim === 0 || nlist === 0) return bufferFromF32(centroids);
  const idx = shuffledIndices(n, nlist, seed);
  for (let c = 0; c < nlist; c++) {
    const src = idx[c % n];
    for (let k = 0; k < dim; k++) centroids[c * dim + k] = v[src * dim + k];
  }
  const assign = new Uint32Array(n);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      const best = nearest(v, i * dim, centroids, nlist, dim);
      if (assign[i] !== best) { assign[i] = best; changed = true; }
    }
    const sums = new Float64Array(nlist * dim);
    const counts = new Uint32Array(nlist);
    for (let i = 0; i < n; i++) {
      const c = assign[i];
      counts[c]++;
      const base = c * dim;
      for (let k = 0; k < dim; k++) sums[base + k] += v[i * dim + k];
    }
    for (let c = 0; c < nlist; c++) {
      if (counts[c] > 0) {
        const inv = 1 / counts[c];
        const base = c * dim;
        for (let k = 0; k < dim; k++) centroids[base + k] = Math.fround(sums[base + k] * inv);
      }
    }
    reseedEmpty(v, n, dim, nlist, counts, assign, centroids);
    if (!changed) break;
  }
  return bufferFromF32(centroids);
}

/** assignCentroids — nearest cell id per vector. Returns Uint32Array(n). */
export function assignCentroids(int8Vectors, n, dim, centroidsBuf, nlist) {
  const v = asInt8(int8Vectors);
  const centroids = f32FromBuffer(centroidsBuf);
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = nearest(v, i * dim, centroids, nlist, dim);
  return out;
}
