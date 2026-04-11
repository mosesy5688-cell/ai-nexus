/**
 * JS fallback shard fusion — streaming variant.
 *
 * V25.9.2: Eliminates the V8 512 MiB single-string limit that bit #1727 in
 * the aggregator. The old path did `fs.readFile` → `toString('utf-8')` → `JSON.parse`,
 * which holds the whole decompressed shard as one JS string and crashes at ≥512 MiB.
 * Now: decompress + parse streamingly via `partitionMonolithStreamingly` (same
 * pattern the aggregator fix uses), so only individual entity objects live on heap.
 *
 * This path only runs when `fuseShardFFI` (Rust) fails or is unavailable. The
 * Rust path is still primary and untouched.
 */
import fs from 'fs/promises';
import path from 'path';
import { autoDecompress } from './zstd-helper.js';
import { partitionMonolithStreamingly } from './aggregator-stream-utils.js';
import { generateUMID } from './umid-generator.js';

export async function fuseShardJS(shardPath, allValidIds, fniThresholds, entityEnrichMap, enrichmentDir) {
    const { projectEntity } = await import('./registry-loader.js');
    const { normalizeId, getNodeSource } = await import('../../utils/id-normalizer.js');

    // Sync pipeline: normalize, re-stamp umid, filter relations, score — no IO.
    // Runs inside the stream consumer so we never hold the full shard string.
    const pending = []; // entities ready for async enrichment + projection
    const pipeline = (result) => {
        const entity = { ...result, ...(result.enriched || {}) };
        if (entity.id) entity.umid = generateUMID(entity.id);
        if (entity.relations) {
            entity.relations = entity.relations.filter(r => {
                const nt = normalizeId(r.target_id, r.target_source || getNodeSource(r.target_id, r.target_type));
                return allValidIds.has(nt);
            });
        }
        entity.fni_pScore = entity.fni_score ?? entity.fni ?? 0;
        entity.fni_percentile = fniThresholds.scorePercentiles?.[entity.fni_pScore] || 0;
        pending.push(entity);
    };

    if (shardPath.endsWith('.bin')) {
        const { readBinaryShard } = await import('./registry-binary-reader.js');
        const parsed = (await readBinaryShard(shardPath))?.entities || [];
        for (const r of parsed) pipeline(r);
    } else {
        // Streaming JSON parse — O(1) string memory regardless of shard size.
        await partitionMonolithStreamingly(shardPath, pipeline);
    }

    // Second pass: async enrichment (fs.readFile) + final projection.
    // Kept separate from the stream consumer because partitionMonolithStreamingly
    // calls consumers synchronously per chunk; awaiting inside would break backpressure.
    const fusedEntities = [];
    let enrichedInShard = 0;
    for (const entity of pending) {
        if (entityEnrichMap.has(entity.id)) {
            try {
                const localPath = path.join(enrichmentDir, `${entity.umid}.md.gz`);
                const raw = await fs.readFile(localPath);
                const fulltext = (await autoDecompress(raw)).toString('utf-8');
                if (fulltext.length > 200) {
                    entity.body_content = fulltext;
                    entity.has_fulltext = fulltext.length > 1000 && (fulltext.match(/^#{1,3}\s/gm) || []).length >= 2;
                    enrichedInShard++;
                }
            } catch { /* file not downloaded for this shard — skip */ }
        }
        fusedEntities.push(projectEntity(entity, false));
    }
    return fusedEntities;
}
