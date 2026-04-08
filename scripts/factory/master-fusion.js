/**
 * Master Fusion Orchestrator V26.6
 * Architecture: Late-Binding FNI & Closed-World Integrity
 * V26.6: FNI V2.0 passthrough (no Sm recalc) + enrichment diagnostics
 */

import fs from 'fs/promises';
import path from 'path';
import { initR2Bridge, createR2ClientFFI, fetchAllR2ETagsFFI, downloadBufferFromR2FFI } from './lib/r2-bridge.js';
import { zstdCompress, autoDecompress } from './lib/zstd-helper.js';
import { initRustBridge, fuseShardFFI } from './lib/rust-bridge.js';
import { loadRegistryShardsSequentially } from './lib/registry-loader.js';
import { generateUMID } from './lib/umid-generator.js';

const CONFIG = {
    CACHE_DIR: process.env.CACHE_DIR || './cache',
    ARTIFACT_DIR: process.env.ARTIFACT_DIR || './artifacts',
    OUTPUT_DIR: './output'
};

/** Per-shard enrichment: download only what this shard needs from R2 (streaming). */
async function downloadShardEnrichment(r2, enrichmentMap, enrichmentDir, shardPath) {
    let entities;
    try {
        if (shardPath.endsWith('.bin')) {
            const { readBinaryShard } = await import('./lib/registry-binary-reader.js');
            entities = (await readBinaryShard(shardPath))?.entities || [];
        } else {
            const { autoDecompress: ad } = await import('./lib/zstd-helper.js');
            const raw = await fs.readFile(shardPath);
            const parsed = JSON.parse((await ad(raw)).toString('utf-8'));
            entities = parsed.entities || parsed || [];
        }
    } catch (err) {
        console.warn(`  [ENRICH] Failed to read shard ${path.basename(shardPath)}: ${err.message}`);
        return 0;
    }
    // Stamp umid on-the-fly for entities that lack it (pre-aggregator shards)
    for (const e of entities) {
        if (!e.umid && e.id) e.umid = generateUMID(e.id);
    }
    const needed = entities.filter(e => e.umid && enrichmentMap.has(e.umid)).map(e => [e.umid, enrichmentMap.get(e.umid)]);
    if (!needed.length) return 0;
    // Write ID→umid manifest so Rust fusion can look up enrichment files
    const manifest = {};
    for (const e of entities) { if (e.id && e.umid) manifest[e.id] = e.umid; }
    await fs.writeFile(path.join(enrichmentDir, 'manifest.json'), JSON.stringify(manifest));
    const CONCURRENCY = 20;
    let ok = 0;
    for (let i = 0; i < needed.length; i += CONCURRENCY) {
        const batch = needed.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(batch.map(async ([umid, key]) => {
            const raw = await downloadBufferFromR2FFI(r2, key);
            await fs.writeFile(path.join(enrichmentDir, `${umid}.md.gz`), raw);
        }));
        ok += results.filter(r => r.status === 'fulfilled').length;
    }
    return ok;
}

/** JS fallback: process shard when Rust is unavailable. */
async function fuseShardJS(shardPath, allValidIds, fniThresholds, enrichmentMap, enrichmentDir, r2, outIdx) {
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
        // Stamp umid on-the-fly if missing (pre-aggregator shards)
        if (!entity.umid && entity.id) entity.umid = generateUMID(entity.id);
        if (entity.relations) {
            entity.relations = entity.relations.filter(r => {
                const nt = normalizeId(r.target_id, r.target_source || getNodeSource(r.target_id, r.target_type));
                return allValidIds.has(nt);
            });
        }
        // FNI V2.0: Preserve 2/4 computed score — no recalculation in fusion
        entity.fni_pScore = entity.fni_score ?? entity.fni ?? 0;
        entity.fni_percentile = fniThresholds.scorePercentiles?.[entity.fni_pScore] || 0;

        if (entity.umid && enrichmentMap.has(entity.umid)) {
            try {
                const localPath = path.join(enrichmentDir, `${entity.umid}.md.gz`);
                let raw;
                try { raw = await fs.readFile(localPath); } catch {
                    // Direct R2 fallback — local pre-download may have missed this entity
                    if (r2) raw = await downloadBufferFromR2FFI(r2, enrichmentMap.get(entity.umid));
                }
                if (raw) {
                    const fulltext = (await autoDecompress(raw)).toString('utf-8');
                    if (fulltext.length > 200) {
                        entity.body_content = fulltext;
                        entity.has_fulltext = fulltext.length > 1000 && (fulltext.match(/^#{1,3}\s/gm) || []).length >= 2;
                        enrichedInShard++;
                    }
                }
            } catch (err) {
                console.warn(`  [ENRICH-JS] ${entity.umid}: ${err.message}`);
            }
        }
        fusedEntities.push(projectEntity(entity, false));
    }
    return fusedEntities;
}

async function main() {
    console.log('[FUSION V26.6] Starting Mesh Fusion...');
    initRustBridge();

    // Phase 1: Build Valid ID Set (Closed World) — streaming, O(1) heap per shard
    const allValidIds = new Set();
    await loadRegistryShardsSequentially(async (entities) => {
        for (const e of entities) allValidIds.add(e.id);
    }, { slim: true });
    console.log(`  [OK] ${allValidIds.size} valid entities`);

    // Write valid IDs to temp file for Rust fuseShardFFI
    const validIdsPath = path.join(CONFIG.OUTPUT_DIR, '.valid-ids.json.zst');
    await fs.mkdir(CONFIG.OUTPUT_DIR, { recursive: true });
    try {
        await fs.writeFile(validIdsPath, await zstdCompress(JSON.stringify([...allValidIds])));
    } catch (e) {
        console.warn(`  [WARN] Valid IDs file write failed (JS fallback will use in-memory Set): ${e.message}`);
    }

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

    // Phase 3: Enrichment — scan R2 index only (download is per-shard in Phase 4)
    const enrichmentDir = path.join(CONFIG.CACHE_DIR, 'enrichment-local');
    await fs.mkdir(enrichmentDir, { recursive: true });
    let enrichmentMap = new Map();
    initR2Bridge();
    const r2 = createR2ClientFFI();
    if (r2) {
        console.log('[FUSION] Phase 3: Scanning R2 enrichment index...');
        try {
            const etags = await fetchAllR2ETagsFFI(r2, ['enrichment/fulltext/']);
            for (const key of etags.keys()) {
                const m = key.match(/enrichment\/fulltext\/[0-9a-f]{2}\/([0-9a-f]+)\.md\.(?:gz|zst)$/);
                if (m) enrichmentMap.set(m[1], key);
            }
            console.log(`  [OK] ${enrichmentMap.size} enrichment files indexed (download deferred to per-shard)`);
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

    console.log(`[FUSION] Phase 4: Fusing ${shardFiles.length} shards...`);
    let totalEnriched = 0, totalDl = 0;
    for (let i = 0; i < shardFiles.length; i++) {
        const shardPath = path.join(CONFIG.ARTIFACT_DIR, shardFiles[i]);
        const outPath = path.join(outDir, `part-${String(i).padStart(3, '0')}.json.zst`);

        // Per-shard enrichment: download from R2 only what this shard needs
        let dlCount = 0;
        if (r2 && enrichmentMap.size > 0) {
            dlCount = await downloadShardEnrichment(r2, enrichmentMap, enrichmentDir, shardPath);
            totalDl += dlCount;
        }

        try {
            // V26.5: Rust fast path
            const result = fuseShardFFI(shardPath, validIdsPath, thresholdsPath, enrichmentDir, outPath);
            if (result) {
                totalEnriched += result.enrichedCount;
                console.log(`  [OK] Shard ${i}/${shardFiles.length}: ${result.entityCount} entities (Rust, ${dlCount} dl, ${result.enrichedCount} enriched)`);
            } else {
                // JS fallback
                const fused = await fuseShardJS(shardPath, allValidIds, fniThresholds, enrichmentMap, enrichmentDir, r2, i);
                await fs.writeFile(outPath, await zstdCompress(JSON.stringify({
                    shardId: i, entities: fused, _ts: new Date().toISOString()
                })));
                console.log(`  [OK] Shard ${i}/${shardFiles.length}: ${fused.length} entities (JS)`);
            }
        } catch (e) {
            console.error(`  [FAIL] Shard ${i}: ${e.message}`);
        }
        // Cleanup per-shard enrichment to avoid disk bloat
        const files = await fs.readdir(enrichmentDir).catch(() => []);
        await Promise.all(files.map(f => fs.unlink(path.join(enrichmentDir, f)).catch(() => {})));
        if (global.gc && i % 10 === 9) global.gc();
    }

    // Cleanup
    await fs.unlink(validIdsPath).catch(() => {});
    await fs.rm(enrichmentDir, { recursive: true }).catch(() => {});
    console.log(`[FUSION V26.6] Complete! Fused to ${outDir} (${totalDl} downloaded, ${totalEnriched} enriched)`);
}

main().catch(err => { console.error('[CRITICAL] Fusion:', err); process.exit(1); });
