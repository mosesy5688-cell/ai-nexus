/**
 * Master Fusion Orchestrator V26.5
 * Architecture: Late-Binding FNI & Closed-World Integrity
 * V26.5: Rust fuse_shard fast path with JS fallback
 */

import fs from 'fs/promises';
import path from 'path';
import { initR2Bridge, createR2ClientFFI, fetchAllR2ETagsFFI, downloadBufferFromR2FFI } from './lib/r2-bridge.js';
import { zstdCompress, autoDecompress } from './lib/zstd-helper.js';
import { fuseShardFFI } from './lib/rust-bridge.js';

const CONFIG = {
    CACHE_DIR: process.env.CACHE_DIR || './cache',
    ARTIFACT_DIR: process.env.ARTIFACT_DIR || './artifacts',
    OUTPUT_DIR: './output'
};

/** Pre-download enrichment files from R2 to local dir for Rust consumption. */
async function preDownloadEnrichment(r2, enrichmentMap, enrichmentDir) {
    let count = 0;
    for (const [umid, key] of enrichmentMap) {
        try {
            const raw = await downloadBufferFromR2FFI(r2, key);
            await fs.writeFile(path.join(enrichmentDir, `${umid}.md.gz`), raw);
            count++;
        } catch { /* non-fatal: skip failed downloads */ }
    }
    return count;
}

/** JS fallback: process shard when Rust is unavailable. */
async function fuseShardJS(shardPath, allValidIds, fniThresholds, enrichmentMap, r2, outIdx) {
    let shardEntities = [];
    if (shardPath.endsWith('.bin')) {
        const { readBinaryShard } = await import('./lib/registry-binary-reader.js');
        shardEntities = (await readBinaryShard(shardPath))?.entities || [];
    } else {
        const raw = await fs.readFile(shardPath);
        shardEntities = JSON.parse((await autoDecompress(raw)).toString('utf-8')).entities || [];
    }
    const { projectEntity } = await import('./lib/registry-loader.js');
    const { normalizeId, getNodeSource } = await import('../utils/id-normalizer.js');
    let fusedEntities = [], enrichedInShard = 0;

    for (const result of shardEntities) {
        const entity = { ...result, ...(result.enriched || {}) };
        if (entity.relations) {
            entity.relations = entity.relations.filter(r => {
                const nt = normalizeId(r.target_id, r.target_source || getNodeSource(r.target_id, r.target_type));
                return allValidIds.has(nt);
            });
        }
        const baseScore = entity.fni_score ?? entity.fni ?? 0;
        const Sm = Math.min(100, fniThresholds.citationCounts?.[entity.id] || 0);
        entity.fni_score = Math.round((baseScore * 0.75) + (Sm * 0.25));
        entity.fni_pScore = entity.fni_score;
        entity.fni_percentile = fniThresholds.scorePercentiles?.[entity.fni_score] || 0;
        if (entity.metrics) entity.metrics.sm = Sm;

        if (entity.type === 'paper' && enrichmentMap.has(entity.umid) && r2 && enrichedInShard < 200) {
            try {
                const raw = await downloadBufferFromR2FFI(r2, enrichmentMap.get(entity.umid));
                const fulltext = (await autoDecompress(raw)).toString('utf-8');
                enrichedInShard++;
                if (fulltext.length > 200) {
                    entity.body_content = fulltext;
                    entity.has_fulltext = fulltext.length > 1000 && (fulltext.match(/^#{1,3}\s/gm) || []).length >= 2;
                }
            } catch { /* non-fatal */ }
        }
        fusedEntities.push(projectEntity(entity, false));
    }
    return fusedEntities;
}

async function main() {
    console.log('[FUSION V26.5] Starting Mesh Fusion...');

    // Phase 1: Build Valid ID Set (Closed World)
    const { loadGlobalRegistry } = await import('./lib/cache-manager.js');
    const registry = await loadGlobalRegistry({ slim: true });
    const validIdsList = (registry.entities || []).map(e => e.id);
    const allValidIds = new Set(validIdsList);
    registry.entities = null;
    if (global.gc) global.gc();
    console.log(`  [OK] ${allValidIds.size} valid entities`);

    // Write valid IDs to temp file for Rust
    const validIdsPath = path.join(CONFIG.OUTPUT_DIR, '.valid-ids.json.zst');
    await fs.mkdir(CONFIG.OUTPUT_DIR, { recursive: true });
    await fs.writeFile(validIdsPath, await zstdCompress(JSON.stringify(validIdsList)));

    // Phase 2: FNI Thresholds
    let fniThresholds = { scorePercentiles: {}, citationCounts: {} };
    const thresholdsPath = path.join(CONFIG.OUTPUT_DIR, 'cache/fni-thresholds.json');
    try {
        if (await fs.access(thresholdsPath).then(() => true).catch(() => false)) {
            fniThresholds = JSON.parse(await fs.readFile(thresholdsPath, 'utf-8'));
        } else {
            console.warn('  [WARN] fni-thresholds.json not found.');
        }
    } catch { /* use defaults */ }

    // Phase 3: Enrichment — scan R2 + pre-download for Rust
    const enrichmentDir = path.join(CONFIG.CACHE_DIR, 'enrichment-local');
    await fs.mkdir(enrichmentDir, { recursive: true });
    let enrichmentMap = new Map();
    initR2Bridge();
    const r2 = createR2ClientFFI();
    if (r2) {
        console.log('[FUSION] Phase 3: Scanning R2 enrichment...');
        try {
            const etags = await fetchAllR2ETagsFFI(r2, ['enrichment/fulltext/']);
            for (const key of etags.keys()) {
                const m = key.match(/enrichment\/fulltext\/[0-9a-f]{2}\/([0-9a-f]+)\.md\.(?:gz|zst)$/);
                if (m) enrichmentMap.set(m[1], key);
            }
            console.log(`  [OK] ${enrichmentMap.size} enrichment files found`);
            const dlCount = await preDownloadEnrichment(r2, enrichmentMap, enrichmentDir);
            console.log(`  [OK] Pre-downloaded ${dlCount} for Rust fusion`);
        } catch (e) { console.warn(`  [WARN] Enrichment: ${e.message}`); }
    } else {
        console.log('[FUSION] Phase 3: No R2 credentials — skipping enrichment');
    }

    // Phase 4: Per-shard fusion
    const artifactFiles = await fs.readdir(CONFIG.ARTIFACT_DIR).catch(() => []);
    const shardFiles = artifactFiles.filter(f =>
        f.startsWith('part-') && (f.endsWith('.bin') || f.endsWith('.json.zst') || f.endsWith('.json.gz') || f.endsWith('.json'))
    ).sort();

    const outDir = path.join(CONFIG.CACHE_DIR, 'fused');
    await fs.mkdir(outDir, { recursive: true });

    for (let i = 0; i < shardFiles.length; i++) {
        const shardPath = path.join(CONFIG.ARTIFACT_DIR, shardFiles[i]);
        const outPath = path.join(outDir, `part-${String(i).padStart(3, '0')}.json.zst`);

        try {
            // V26.5: Rust fast path
            const result = fuseShardFFI(shardPath, validIdsPath, thresholdsPath, enrichmentDir, outPath);
            if (result) {
                console.log(`  [OK] Shard ${i}: ${result.entityCount} entities (Rust, ${result.enrichedCount} enriched)`);
                continue;
            }
            // JS fallback
            const fused = await fuseShardJS(shardPath, allValidIds, fniThresholds, enrichmentMap, r2, i);
            await fs.writeFile(outPath, await zstdCompress(JSON.stringify({
                shardId: i, entities: fused, _ts: new Date().toISOString()
            })));
            console.log(`  [OK] Shard ${i}: ${fused.length} entities (JS)`);
        } catch (e) {
            console.error(`  [FAIL] Shard ${i}: ${e.message}`);
        }
        if (global.gc && i % 10 === 9) global.gc();
    }

    // Cleanup
    await fs.unlink(validIdsPath).catch(() => {});
    await fs.rm(enrichmentDir, { recursive: true }).catch(() => {});
    console.log(`[FUSION V26.5] Complete! Fused to ${outDir}`);
}

main().catch(err => { console.error('[CRITICAL] Fusion:', err); process.exit(1); });
