/**
 * Master Fusion Orchestrator V18.12.5.21
 * Architecture: Late-Binding FNI & Closed-World Integrity
 * Optimized for: Split-DB Architecture (Partitioned Output)
 */

import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';

// Configuration
const CONFIG = {
    TOTAL_SHARDS: 20,
    CACHE_DIR: process.env.CACHE_DIR || './cache',
    ARTIFACT_DIR: process.env.ARTIFACT_DIR || './artifacts',
    OUTPUT_DIR: './output'
};

async function main() {
    console.log('[FUSION] 🛡️ Starting Industrial-Scale Knowledge Mesh Fusion...');

    // 1. Load Global Registry Fragments (Baseline ID Map)
    const { loadGlobalRegistry } = await import('./lib/cache-manager.js');
    console.log('[FUSION] Phase 1: Building Global ID Map (Closed World)...');

    // We load registry slim to save RAM (190k IDs is ~15MB)
    const registry = await loadGlobalRegistry({ slim: true });
    const entities = registry.entities || [];
    const allValidIds = new Set(entities.map(e => e.id));
    console.log(`  [OK] Validated ${allValidIds.size} entities in reference baseline.`);

    // 2. Load Late-Binding FNI Metrics (from Stage 3/4)
    console.log('[FUSION] Phase 2: Loading Late-Binding FNI Targets...');
    let fniThresholds = { scorePercentiles: {}, citationCounts: {} };
    try {
        const thresholdPath = path.join(CONFIG.OUTPUT_DIR, 'cache/fni-thresholds.json');
        if (await fs.access(thresholdPath).then(() => true).catch(() => false)) {
            const data = await fs.readFile(thresholdPath, 'utf-8');
            fniThresholds = JSON.parse(data);
            const count = Object.keys(fniThresholds.scorePercentiles).length;
            console.log(`  [OK] Loaded ${count} FNI percentiles and ${Object.keys(fniThresholds.citationCounts).length} citation weights.`);
        } else {
            console.warn('  [WARN] fni-thresholds.json not found. Rank data will be stale.');
        }
    } catch (e) {
        console.error('  [ERROR] Failed to load thresholds:', e.message);
    }

    // 3. Iterative Shard Merge (Partitioned Output)
    const { projectEntity } = await import('./lib/registry-loader.js');
    // V22.8: Dynamically scan ARTIFACT_DIR for available shards (supports both shard-N and part-NNN naming)
    const artifactFiles = await fs.readdir(CONFIG.ARTIFACT_DIR).catch(() => []);
    const shardFiles = artifactFiles.filter(f => f.endsWith('.json.gz')).sort();

    if (shardFiles.length === 0) {
        console.log('  [WARN] No shard files found in ARTIFACT_DIR. Fusion will produce empty output.');
    }

    for (let i = 0; i < shardFiles.length; i++) {
        const shardFile = path.join(CONFIG.ARTIFACT_DIR, shardFiles[i]);

        try {
            const raw = await fs.readFile(shardFile);
            const decompressed = zlib.gunzipSync(raw);
            const shard = JSON.parse(decompressed.toString('utf-8'));
            const shardEntities = shard.entities || [];

            const fusedEntities = [];
            for (const result of shardEntities) {
                const entity = result.enriched || result;

                // A. Closed World Filter (No broken links)
                if (entity.relations) {
                    const { normalizeId, getNodeSource } = await import('../utils/id-normalizer.js');
                    entity.relations = entity.relations.filter(r => {
                        const normTarget = normalizeId(r.target_id, r.target_source || getNodeSource(r.target_id, r.target_type));
                        return allValidIds.has(normTarget);
                    });
                }

                // B. Apply Late-Binding FNI (V16.5 SPEC: Vitality 75% + Mesh 25%)
                const baseScore = entity.fni_score ?? entity.fni ?? 0;
                const Sm = Math.min(100, fniThresholds.citationCounts?.[entity.id] || 0);
                const finalFni = Math.round((baseScore * 0.75) + (Sm * 0.25));
                const percentile = fniThresholds.scorePercentiles?.[finalFni] || 0;

                entity.fni_score = finalFni;
                entity.fni_pScore = finalFni; // Backup for search engine
                entity.fni_percentile = percentile;
                if (entity.metrics) {
                    entity.metrics.sm = Sm;
                }

                // C. Project for VFS (Partitioned Registry Storage)
                fusedEntities.push(projectEntity(entity, false));
            }

            // Write Partitioned Registry to cache/fused (V22.8: matches tar packaging path)
            const outDir = path.join(CONFIG.CACHE_DIR, 'fused');
            await fs.mkdir(outDir, { recursive: true });
            const outPath = path.join(outDir, `part-${String(i).padStart(3, '0')}.json.gz`);

            await fs.writeFile(outPath, zlib.gzipSync(JSON.stringify({
                shardId: i,
                entities: fusedEntities,
                _ts: new Date().toISOString()
            })));

            console.log(`  [OK] Shard ${i}: Fused ${fusedEntities.length} entities.`);
        } catch (e) {
            console.error(`  [FAIL] Shard ${i} processing error:`, e.message);
        }
    }

    console.log(`[FUSION] ✅ Complete! Industry-Grade Mesh Fused to ${CONFIG.OUTPUT_DIR}/registry/`);
}

main().catch(err => {
    console.error('[CRITICAL] Fusion Failure:', err);
    process.exit(1);
});
