/**
 * V26.7 Cluster Semantic Engine — Approximate S-factor via 128 centroids.
 * Loads cluster centroids (~393KB) + entity→cluster map (~1MB) from R2/CDN.
 * At query time: cosine(query, centroids) → entity's cluster centroid score = S.
 */
import { env } from 'cloudflare:workers';

let centroids: Float32Array[] | null = null;
let clusterCount = 0;
let vectorDim = 0;
let entityClusterMap: Record<string, number> | null = null;

async function loadCentroids(r2Bucket: any, isDev: boolean) {
    if (centroids) return;
    const key = 'data/cluster-ann-index.bin';
    let buf: ArrayBuffer;
    if (r2Bucket && !isDev) {
        const obj = await r2Bucket.get(key);
        if (!obj) return;
        buf = await obj.arrayBuffer();
    } else {
        const res = await fetch(`https://cdn.free2aitools.com/${key}`);
        if (!res.ok) return;
        buf = await res.arrayBuffer();
    }
    const dv = new DataView(buf);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== 'CANN') return;
    clusterCount = dv.getUint16(6, true);
    vectorDim = dv.getUint16(8, true);
    centroids = [];
    let pos = 20;
    for (let c = 0; c < clusterCount; c++) {
        const vec = new Float32Array(vectorDim);
        for (let d = 0; d < vectorDim; d++) { vec[d] = dv.getFloat32(pos, true); pos += 4; }
        centroids.push(vec);
    }
}

async function loadEntityMap(r2Bucket: any, isDev: boolean) {
    if (entityClusterMap) return;
    const key = 'data/cluster-ann-index-entity-map.json';
    try {
        if (r2Bucket && !isDev) {
            const obj = await r2Bucket.get(key);
            if (!obj) return;
            entityClusterMap = await obj.json();
        } else {
            const res = await fetch(`https://cdn.free2aitools.com/${key}`);
            if (!res.ok) return;
            entityClusterMap = await res.json();
        }
    } catch { entityClusterMap = null; }
}

function cosine(a: number[] | Float32Array, b: Float32Array): number {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < b.length; i++) {
        const ai = i < a.length ? a[i] : 0;
        dot += ai * b[i]; magA += ai * ai; magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom > 0 ? dot / denom : 0;
}

/** Initialize: load centroids + entity map. Call once per isolate. */
export async function initClusterSemantic(r2Bucket: any, isDev: boolean) {
    await Promise.all([loadCentroids(r2Bucket, isDev), loadEntityMap(r2Bucket, isDev)]);
    return !!(centroids && entityClusterMap);
}

/** Get approximate S score for an entity given a query embedding. */
export function getClusterSemanticScore(queryEmbedding: number[], entityId: string): number {
    if (!centroids || !entityClusterMap) return 50.0;
    const clusterId = entityClusterMap[entityId];
    if (clusterId === undefined) return 50.0;
    return Math.min(99.9, cosine(queryEmbedding, centroids[clusterId]) * 100);
}

/** Get all centroid scores for a query (for Tier 2 fallback — top-K cluster routing). */
export function rankCentroids(queryEmbedding: number[], topK: number = 3): { clusterId: number; score: number }[] {
    if (!centroids) return [];
    const scores = centroids.map((c, i) => ({ clusterId: i, score: cosine(queryEmbedding, c) }));
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, topK);
}

export function isReady(): boolean { return !!(centroids && entityClusterMap); }
export function getClusterCount(): number { return clusterCount; }
