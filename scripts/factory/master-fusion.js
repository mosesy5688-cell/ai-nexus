/**
 * Master Fusion Orchestrator V18.12.5.21
 * Architecture: Late-Binding FNI & Closed-World Integrity
 * Optimized for: Split-DB Architecture (Partitioned Output)
 */

import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';
import { createR2Client, fetchAllR2ETags } from './lib/r2-helpers.js';
import { zstdCompress, autoDecompress } from './lib/zstd-helper.js';
import { GetObjectCommand } from '@aws-sdk/client-s3';

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
            const parsed = JSON.parse(data);
            fniThresholds.scorePercentiles = parsed.scorePercentiles || {};
            fniThresholds.citationCounts = parsed.citationCounts || {};
            console.log(`  [OK] Loaded ${Object.keys(fniThresholds.scorePercentiles).length} FNI percentiles and ${Object.keys(fniThresholds.citationCounts).length} citation weights.`);
        } else {
            console.warn('  [WARN] fni-thresholds.json not found. Rank data will be stale.');
        }
    } catch (e) {
        console.error(`  [WARN] Failed to load thresholds: ${e.message}. Using defaults.`);
    }

    // 3. V25.8.3 T+1 Enrichment Fusion Sweep (Spec §3.1)
    let enrichmentMap = new Map();
    const r2 = createR2Client();
    if (r2) {
        console.log('[FUSION] Phase 3: Scanning R2 enrichment/fulltext/ for T+1 fusion...');
        try {
            const etags = await fetchAllR2ETags(r2, process.env.R2_BUCKET || 'ai-nexus-assets', ['enrichment/fulltext/']);
            for (const key of etags.keys()) {
                const m = key.match(/enrichment\/fulltext\/[0-9a-f]{2}\/([0-9a-f]+)\.md\.gz$/);
                if (m) enrichmentMap.set(m[1], key);
            }
            console.log(`  [OK] ${enrichmentMap.size} enriched papers ready for T+1 fusion`);
        } catch (e) { console.warn(`  [WARN] Enrichment scan failed: ${e.message}`); }
    } else {
        console.log('[FUSION] Phase 3: No R2 credentials — skipping enrichment fusion');
    }

    // 4. Iterative Shard Merge (Partitioned Output)
    const { projectEntity } = await import('./lib/registry-loader.js');
    // V22.8: Dynamically scan ARTIFACT_DIR for available shards (supports both shard-N and part-NNN naming)
    const artifactFiles = await fs.readdir(CONFIG.ARTIFACT_DIR).catch(() => []);
    // V25.9: Accept .bin (NXVF) + .json.zst + .json.gz + .json
    const shardFiles = artifactFiles.filter(f =>
        f.startsWith('part-') && (f.endsWith('.bin') || f.endsWith('.json.zst') || f.endsWith('.json.gz') || f.endsWith('.json'))
    ).sort();

    if (shardFiles.length === 0) {
        console.log('  [WARN] No shard files found in ARTIFACT_DIR. Fusion will produce empty output.');
    }

    for (let i = 0; i < shardFiles.length; i++) {
        const shardFile = path.join(CONFIG.ARTIFACT_DIR, shardFiles[i]);

        try {
            let shardEntities = [];
            if (shardFiles[i].endsWith('.bin')) {
                // V25.8.3: NXVF binary shard — delegate to binary reader
                const { readBinaryShard } = await import('./lib/registry-binary-reader.js');
                const result = await readBinaryShard(shardFile);
                shardEntities = result?.entities || [];
            } else {
                const raw = await fs.readFile(shardFile);
                const decompressed = await autoDecompress(raw);
                const shard = JSON.parse(decompressed.toString('utf-8'));
                shardEntities = shard.entities || [];
            }
            let fusedEntities = [];

            const outDir = path.join(CONFIG.CACHE_DIR, 'fused');
            await fs.mkdir(outDir, { recursive: true });

            for (const result of shardEntities) {
                const entity = { ...result, ...(result.enriched || {}) };

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

                // C. T+1 Enrichment Fusion (Spec §3.2: inject fulltext from 1.5 Density Booster)
                if (entity.type === 'paper' && enrichmentMap.has(entity.umid) && r2) {
                    try {
                        const { Body } = await r2.send(new GetObjectCommand({
                            Bucket: process.env.R2_BUCKET || 'ai-nexus-assets',
                            Key: enrichmentMap.get(entity.umid)
                        }));
                        const chunks = []; for await (const c of Body) chunks.push(c);
                        const fulltext = zlib.gunzipSync(Buffer.concat(chunks)).toString('utf-8');
                        // Spec §2.2: SUCCESS (>1000 + headers) → has_fulltext=true; PARTIAL (200-1000) → content only
                        if (fulltext.length > 200) {
                            entity.body_content = fulltext;
                            entity.has_fulltext = fulltext.length > 1000 && (fulltext.match(/^#{1,3}\s/gm) || []).length >= 2;
                        }
                    } catch { /* non-fatal: keep original content */ }
                }

                // D. Project for VFS (Partitioned Registry Storage)
                const projected = projectEntity(entity, false);
                fusedEntities.push(projected);
            }

            // Write Partitioned Registry for VFS Packer support
            const outPath = path.join(outDir, `part-${String(i).padStart(3, '0')}.json.zst`);

            await fs.writeFile(outPath, await zstdCompress(JSON.stringify({
                shardId: i,
                entities: fusedEntities,
                _ts: new Date().toISOString()
            })));

            console.log(`  [OK] Shard ${i}: Fused ${fusedEntities.length} entities.`);
        } catch (e) {
            console.error(`  [FAIL] Shard ${i} processing error:`, e.message);
        }
    }

    console.log(`[FUSION] ✅ Complete! Industry-Grade Mesh Fused to ${CONFIG.CACHE_DIR}/fused/`);
}

main().catch(err => {
    console.error('[CRITICAL] Fusion Failure:', err);
    process.exit(1);
});
