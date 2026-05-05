/**
 * V2.0 Cluster ANN Builder — k-Means 128-cluster ANN Index
 * SSR query: embed → top-K centroids → scan clusters (~128x speedup)
 * Memory: 434K × 768 × 4B ≈ 1.3GB | Output: ~300KB index
 */

import fsSync from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const NUM_CLUSTERS = 128;
const MAX_ITERATIONS = 20;
const CONVERGENCE_THRESHOLD = 0.001;
const VECTOR_DIM = 768;
const OUTPUT_PATH = './output/data/cluster-ann-index.bin';

/** Load Int8 vectors from embedding cache → Float32. */
function loadVectorsFromCache(cachePath) {
    const { iterateAllVectors } = require('./embedding-shard-cache.js');
    const ids = [];
    const vectors = [];

    for (const { id, vector } of iterateAllVectors(cachePath)) {
        if (vector.length !== VECTOR_DIM) continue;
        const float32 = new Float32Array(VECTOR_DIM);
        for (let i = 0; i < VECTOR_DIM; i++) {
            float32[i] = vector[i] / 127.0;
        }
        ids.push(row.id);
        vectors.push(float32);
    }

    return { ids, vectors };
}

/** k-means++ centroid seeding. */
function initCentroids(vectors, k) {
    const centroids = [];
    const n = vectors.length;

    // First centroid: random
    centroids.push(Float32Array.from(vectors[Math.floor(Math.random() * n)]));

    // Remaining centroids: weighted by distance²
    const distances = new Float32Array(n).fill(Infinity);

    for (let c = 1; c < k; c++) {
        const lastCentroid = centroids[c - 1];
        let totalDist = 0;

        for (let i = 0; i < n; i++) {
            const d = sqEuclidean(vectors[i], lastCentroid);
            if (d < distances[i]) distances[i] = d;
            totalDist += distances[i];
        }

        // Weighted random selection
        let threshold = Math.random() * totalDist;
        for (let i = 0; i < n; i++) {
            threshold -= distances[i];
            if (threshold <= 0) {
                centroids.push(Float32Array.from(vectors[i]));
                break;
            }
        }

        if (centroids.length <= c) {
            centroids.push(Float32Array.from(vectors[Math.floor(Math.random() * n)]));
        }

        if (c % 32 === 0) console.log(`[CLUSTER-ANN] Seeding: ${c}/${k}`);
    }

    return centroids;
}

/** Squared Euclidean distance (no sqrt needed for comparison). */
function sqEuclidean(a, b) {
    let sum = 0;
    for (let i = 0; i < VECTOR_DIM; i++) {
        const diff = a[i] - b[i];
        sum += diff * diff;
    }
    return sum;
}

/** Run k-means clustering → { centroids, assignments }. */
function kMeans(vectors, k) {
    const n = vectors.length;
    console.log(`[CLUSTER-ANN] k-Means: ${n} vectors, ${k} clusters, ${VECTOR_DIM}D`);

    let centroids = initCentroids(vectors, k);
    const assignments = new Int32Array(n);

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
        const startMs = Date.now();

        // Assignment step: each vector → nearest centroid
        for (let i = 0; i < n; i++) {
            let bestDist = Infinity, bestCluster = 0;
            for (let c = 0; c < k; c++) {
                const d = sqEuclidean(vectors[i], centroids[c]);
                if (d < bestDist) { bestDist = d; bestCluster = c; }
            }
            assignments[i] = bestCluster;
        }

        // Update step: recompute centroids as mean of assigned vectors
        const sums = Array.from({ length: k }, () => new Float64Array(VECTOR_DIM));
        const counts = new Int32Array(k);

        for (let i = 0; i < n; i++) {
            const c = assignments[i];
            counts[c]++;
            const vec = vectors[i];
            const sum = sums[c];
            for (let d = 0; d < VECTOR_DIM; d++) sum[d] += vec[d];
        }

        let maxShift = 0;
        const newCentroids = [];
        for (let c = 0; c < k; c++) {
            const centroid = new Float32Array(VECTOR_DIM);
            if (counts[c] > 0) {
                for (let d = 0; d < VECTOR_DIM; d++) {
                    centroid[d] = sums[c][d] / counts[c];
                }
            } else {
                // Empty cluster: reinitialize to random vector
                const ri = Math.floor(Math.random() * n);
                centroid.set(vectors[ri]);
            }
            maxShift = Math.max(maxShift, sqEuclidean(centroid, centroids[c]));
            newCentroids.push(centroid);
        }
        centroids = newCentroids;

        const elapsed = Date.now() - startMs;
        const emptyClusters = counts.filter(c => c === 0).length;
        console.log(`[CLUSTER-ANN] Iter ${iter + 1}: shift=${maxShift.toFixed(6)}, empty=${emptyClusters}, ${elapsed}ms`);

        if (maxShift < CONVERGENCE_THRESHOLD) {
            console.log(`[CLUSTER-ANN] Converged at iteration ${iter + 1}`);
            break;
        }
    }

    return { centroids, assignments };
}

/** Serialize: Header(20B) + Centroids(k×dim×4) + OffsetTable(k×8) + EntityLists. */
function serializeIndex(centroids, assignments, totalVectors) {
    const k = centroids.length;
    const HEADER_SIZE = 20;
    const centroidBytes = k * VECTOR_DIM * 4;
    const offsetTableBytes = k * 8;

    // Build cluster membership lists
    const clusters = Array.from({ length: k }, () => []);
    for (let i = 0; i < totalVectors; i++) {
        clusters[assignments[i]].push(i);
    }

    const entityListBytes = totalVectors * 4;
    const totalSize = HEADER_SIZE + centroidBytes + offsetTableBytes + entityListBytes;
    const buf = Buffer.alloc(totalSize);

    // Header
    buf.write('CANN', 0, 4, 'ascii');
    buf.writeUInt16LE(1, 4); // version
    buf.writeUInt16LE(k, 6);
    buf.writeUInt16LE(VECTOR_DIM, 8);
    buf.writeUInt32LE(totalVectors, 10);

    // Centroid table
    let pos = HEADER_SIZE;
    for (let c = 0; c < k; c++) {
        for (let d = 0; d < VECTOR_DIM; d++) {
            buf.writeFloatLE(centroids[c][d], pos);
            pos += 4;
        }
    }

    // Cluster offset table + entity lists
    const offsetTableStart = pos;
    let entityListPos = offsetTableStart + offsetTableBytes;

    for (let c = 0; c < k; c++) {
        buf.writeUInt32LE(entityListPos, offsetTableStart + c * 8);
        buf.writeUInt32LE(clusters[c].length, offsetTableStart + c * 8 + 4);

        for (const idx of clusters[c]) {
            buf.writeUInt32LE(idx, entityListPos);
            entityListPos += 4;
        }
    }

    return buf;
}

/** Build Cluster ANN index from embedding cache (called from pack-db.js). */
export async function buildClusterAnnIndex(cachePath) {
    console.log('[CLUSTER-ANN] Building Cluster ANN Index (V2.0)...');
    const start = Date.now();

    const { ids, vectors } = loadVectorsFromCache(cachePath);
    if (vectors.length < NUM_CLUSTERS * 10) {
        console.warn(`[CLUSTER-ANN] Only ${vectors.length} vectors, skipping.`);
        return;
    }

    const { centroids, assignments } = kMeans(vectors, NUM_CLUSTERS);
    const buf = serializeIndex(centroids, assignments, vectors.length);

    fsSync.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fsSync.writeFileSync(OUTPUT_PATH, buf);

    // Entity index → entity ID mapping
    const idMapPath = OUTPUT_PATH.replace('.bin', '-ids.json');
    fsSync.writeFileSync(idMapPath, JSON.stringify(ids));

    // Entity ID → cluster ID mapping (for SSR cluster semantic scoring)
    const entityClusterMap = {};
    for (let i = 0; i < ids.length; i++) entityClusterMap[ids[i]] = assignments[i];
    const mapPath = OUTPUT_PATH.replace('.bin', '-entity-map.json');
    fsSync.writeFileSync(mapPath, JSON.stringify(entityClusterMap));
    console.log(`[CLUSTER-ANN] Entity→cluster map: ${ids.length} entries → ${mapPath}`);

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const sizeMB = (buf.length / 1024 / 1024).toFixed(2);
    console.log(`[CLUSTER-ANN] ✅ Built ${NUM_CLUSTERS} clusters over ${vectors.length} vectors in ${elapsed}s (${sizeMB} MB)`);
}
