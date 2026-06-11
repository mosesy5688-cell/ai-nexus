/**
 * V26.7 Cluster Semantic Fallback — Tier 2 replacement for broken vector-core.bin brute-force.
 * Uses cluster centroid routing to find semantically similar entities across the full catalog.
 */
import { initClusterSemantic, rankCentroids, isReady } from './cluster-semantic-engine.js';
import { embedQuery } from './semantic-engine.js';
import { withOpTimeout, EMBED_TIMEOUT_MS } from './search-budget.js';

/**
 * B8 per-op firewalls for the Tier-2 fallback. `opTimeoutMs` (the route's
 * per-op budget) bounds each full .bin / ids.json R2 GET — these are LARGE reads
 * that have hung unbounded in prod. The Workers-AI embed is bounded separately by
 * EMBED_TIMEOUT_MS (a network call to the AI binding). Without a config the
 * function runs unbounded (legacy callers / tests).
 */
export interface FallbackBudget {
    /** Per-op cap for each full-bin / ids R2 GET (route's remaining op budget). */
    opTimeoutMs?: number;
    /** Cap for the Workers-AI embed call. Defaults to EMBED_TIMEOUT_MS. */
    embedTimeoutMs?: number;
}

export async function clusterFallbackSearch(
    query: string, limit: number, r2Bucket: any, isDev: boolean, manifest: any, env: any,
    budget?: FallbackBudget,
): Promise<{ id: string; score: number; shard: number }[] | null> {
    const opCap = budget?.opTimeoutMs;
    const embedCap = budget?.embedTimeoutMs ?? EMBED_TIMEOUT_MS;
    const bound = <T>(p: Promise<T>, label: string, ms?: number): Promise<T> =>
        ms ? withOpTimeout(p, ms, label) : p;

    await bound(initClusterSemantic(r2Bucket, isDev), 'fallback:init', opCap);
    // B8: the embed is the worst unbounded op (AI binding network call). Bound it
    // tightly; on timeout we return null -> the route degrades to an honest signal.
    const qEmb = isReady() ? await bound(embedQuery(query, env), 'fallback:embed', embedCap) : null;
    if (!qEmb || !isReady()) return null;

    const topClusters = rankCentroids(qEmb, 3);

    const idsRes = r2Bucket
        ? await bound(r2Bucket.get('data/cluster-ann-index-ids.json'), 'fallback:ids', opCap)
        : await bound(fetch('https://cdn.free2aitools.com/data/cluster-ann-index-ids.json'), 'fallback:ids', opCap);
    const allIds: string[] = r2Bucket ? await idsRes.json() : await (idsRes as Response).json();

    const binRes = r2Bucket
        ? await bound(r2Bucket.get('data/cluster-ann-index.bin'), 'fallback:bin', opCap)
        : await bound(fetch('https://cdn.free2aitools.com/data/cluster-ann-index.bin'), 'fallback:bin', opCap);
    const binBuf: ArrayBuffer = r2Bucket ? await binRes.arrayBuffer() : await (binRes as Response).arrayBuffer();
    const dv = new DataView(binBuf);
    const k = dv.getUint16(6, true), dim = dv.getUint16(8, true);
    const offsetTableStart = 20 + k * dim * 4;

    const { xxhash64Mod } = await import('../utils/xxhash64.js');
    const shardCount = manifest?.partitions?.meta_shards || 96;
    const candidates: { id: string; score: number; shard: number }[] = [];

    for (const { clusterId, score } of topClusters) {
        const listOffset = dv.getUint32(offsetTableStart + clusterId * 8, true);
        const listLen = dv.getUint32(offsetTableStart + clusterId * 8 + 4, true);
        for (let i = 0; i < Math.min(listLen, 200); i++) {
            const idx = dv.getUint32(listOffset + i * 4, true);
            if (idx < allIds.length) {
                const id = allIds[idx];
                candidates.push({ id, score: score * 100, shard: xxhash64Mod(id, shardCount) });
            }
        }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, limit * 3);
}
