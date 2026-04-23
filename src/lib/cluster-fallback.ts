/**
 * V26.7 Cluster Semantic Fallback — Tier 2 replacement for broken vector-core.bin brute-force.
 * Uses cluster centroid routing to find semantically similar entities across all 464K.
 */
import { initClusterSemantic, rankCentroids, isReady } from './cluster-semantic-engine.js';
import { embedQuery } from './semantic-engine.js';

export async function clusterFallbackSearch(
    query: string, limit: number, r2Bucket: any, isDev: boolean, manifest: any, env: any
): Promise<{ id: string; score: number; shard: number }[] | null> {
    await initClusterSemantic(r2Bucket, isDev);
    const qEmb = isReady() ? await embedQuery(query, env) : null;
    if (!qEmb || !isReady()) return null;

    const topClusters = rankCentroids(qEmb, 3);

    const idsRes = r2Bucket
        ? await r2Bucket.get('data/cluster-ann-index-ids.json')
        : await fetch('https://cdn.free2aitools.com/data/cluster-ann-index-ids.json');
    const allIds: string[] = r2Bucket ? await idsRes.json() : await (idsRes as Response).json();

    const binRes = r2Bucket
        ? await r2Bucket.get('data/cluster-ann-index.bin')
        : await fetch('https://cdn.free2aitools.com/data/cluster-ann-index.bin');
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
