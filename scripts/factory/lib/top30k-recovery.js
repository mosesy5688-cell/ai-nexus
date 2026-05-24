// V27.41: extracted from pack-db.js (CES Art 5.1 Monolith Ban)
// Recovers Top-30k entities with embedding vectors from meta shards.

import { readEmbeddingShard } from './embedding-shard-cache.js';

const VEC_DIM = 768;

export async function recoverTop30k(metaDbs, cachedIdToShard, idToShardIdx, embedShardDir) {
    console.log('[VFS] Recovering Top-30k vectors from meta shards...');
    const top30k = [];
    for (const db of Object.values(metaDbs)) {
        const rows = db.prepare(
            `SELECT id, slug, name, type, author, license, pipeline_tag, category, fni_score,
             downloads, stars, params_billions, context_length, last_modified, is_trending
             FROM entities ORDER BY fni_score DESC, raw_pop DESC, slug ASC LIMIT 30000`
        ).all();
        top30k.push(...rows);
    }
    top30k.sort((a, b) => (b.fni_score || 0) - (a.fni_score || 0));
    top30k.length = Math.min(top30k.length, 30000);

    const vecShardCache = new Map();
    for (const row of top30k) {
        const eid = row.id || row.slug;
        const si = cachedIdToShard.get(eid) ?? idToShardIdx.get(eid);
        if (si == null) continue;
        if (!vecShardCache.has(si)) {
            vecShardCache.set(si, await readEmbeddingShard(embedShardDir, si) || new Map());
        }
        const vec = vecShardCache.get(si).get(eid);
        if (vec) {
            const f32 = new Float32Array(VEC_DIM);
            for (let j = 0; j < VEC_DIM; j++) f32[j] = vec[j] / 127.0;
            row.embedding = Array.from(f32);
        }
    }
    vecShardCache.clear();

    const withVec = top30k.filter(r => r.embedding).length;
    console.log(`[VFS] Top-30k vectors: ${withVec}/${top30k.length} from embedding shards`);
    return top30k;
}
