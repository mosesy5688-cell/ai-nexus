/**
 * Master Fusion Orchestrator V26.8
 * Architecture: Late-Binding FNI & Closed-World Integrity
 * V26.8: Zero double-read enrichment — Phase 1 captures shard→IDs,
 *         Phase 3 builds global entity→R2 mapping, Phase 4 downloads per-shard O(1) disk.
 */

import fs from 'fs/promises';
import path from 'path';
import { initR2Bridge, createR2ClientFFI, fetchAllR2ETagsFFI, downloadBufferFromR2FFI } from './lib/r2-bridge.js';
import { zstdCompress } from './lib/zstd-helper.js';
import { initRustBridge, fuseShardFFI } from './lib/rust-bridge.js';
import { loadRegistryShardsSequentially } from './lib/registry-loader.js';
import { generateUMID, generateDevUMID } from './lib/umid-generator.js';
import { fuseShardJS } from './lib/fuse-shard-js.js';
import { installExitGuard, assertCompletion, writeSentinel } from './lib/fusion-completion-guard.js';

const CONFIG = {
    CACHE_DIR: process.env.CACHE_DIR || './cache',
    ARTIFACT_DIR: process.env.ARTIFACT_DIR || './artifacts',
    OUTPUT_DIR: './output'
};

async function main() {
    console.log('[FUSION V26.8] Starting Mesh Fusion...');
    initRustBridge();

    // Phase 1: Build Valid ID Set + Shard→IDs index (single read, no double-read in Phase 4)
    const allValidIds = new Set();
    const shardEntityIds = new Map(); // shardIdx → [entity_id, ...]
    await loadRegistryShardsSequentially(async (entities, shardIdx) => {
        const ids = [];
        for (const e of entities) { allValidIds.add(e.id); ids.push(e.id); }
        shardEntityIds.set(shardIdx, ids);
    }, { slim: true });
    console.log(`  [OK] ${allValidIds.size} valid entities across ${shardEntityIds.size} shards`);

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

    // Phase 3: Enrichment — scan R2 + build global entity→enrichment mapping (memory only)
    const enrichmentDir = path.join(CONFIG.CACHE_DIR, 'enrichment-local');
    await fs.mkdir(enrichmentDir, { recursive: true });
    let enrichmentMap = new Map();
    let entityEnrichMap = new Map();
    let coldBodyMap = new Map();
    initR2Bridge();
    const r2 = createR2ClientFFI();
    if (r2) {
        console.log('[FUSION] Phase 3: Scanning R2 enrichment + cold shard bundles...');
        try {
            const etags = await fetchAllR2ETagsFFI(r2, ['enrichment/fulltext/']);
            for (const key of etags.keys()) {
                const m = key.match(/enrichment\/fulltext\/[0-9a-f]{2}\/([0-9a-f]+)\.md\.(?:gz|zst)$/);
                if (m) enrichmentMap.set(m[1], key);
            }
            console.log(`  [OK] ${enrichmentMap.size} enrichment files indexed`);
        } catch (e) { console.warn(`  [WARN] Enrichment scan: ${e.message}`); }
        // A3: Load cold shard bundles (fallback for entities without enrichment)
        try {
            const coldKeys = [...(await fetchAllR2ETagsFFI(r2, ['cold/shard/'])).keys()].filter(k => k.endsWith('.jsonl.zst'));
            if (coldKeys.length > 0) {
                const { autoDecompress } = await import('./lib/zstd-helper.js');
                for (const key of coldKeys) {
                    try {
                        const text = (await autoDecompress(await downloadBufferFromR2FFI(r2, key))).toString('utf-8');
                        for (const line of text.split('\n')) {
                            if (!line) continue;
                            try { const { id, body } = JSON.parse(line); if (id && body) coldBodyMap.set(id, body); } catch { }
                        }
                    } catch (e) { console.warn(`  [COLD] ${key}: ${e.message}`); }
                }
                console.log(`  [OK] ${coldBodyMap.size} cold bodies from ${coldKeys.length} bundles`);
            }
        } catch (e) { console.warn(`  [WARN] Cold scan: ${e.message}`); }
        if (enrichmentMap.size > 0) {
            let prodHits = 0, devHits = 0;
            for (const id of allValidIds) {
                const prodUmid = generateUMID(id);
                if (enrichmentMap.has(prodUmid)) {
                    entityEnrichMap.set(id, prodUmid); prodHits++;
                } else {
                    const devUmid = generateDevUMID(id);
                    if (enrichmentMap.has(devUmid)) {
                        entityEnrichMap.set(id, devUmid); devHits++;
                    }
                }
            }
            console.log(`  [OK] ${entityEnrichMap.size} entities have enrichment (prod=${prodHits}, devSalt=${devHits})`);
        }
    } else {
        console.log('[FUSION] Phase 3: No R2 credentials — skipping enrichment');
    }

    // Phase 4: Per-shard fusion (single shard read, per-shard download O(1) disk)
    const artifactFiles = await fs.readdir(CONFIG.ARTIFACT_DIR).catch(() => []);
    const allShardFiles = artifactFiles.filter(f =>
        f.startsWith('part-') && (f.endsWith('.bin') || f.endsWith('.json.zst') || f.endsWith('.json.gz') || f.endsWith('.json'))
    ).sort();

    const expectedIndices = new Set(shardEntityIds.keys());
    const staleFiles = [];
    const shardFiles = allShardFiles.filter(f => {
        const idx = parseInt(f.match(/part-(\d+)/)?.[1] ?? '-1');
        if (expectedIndices.has(idx)) return true;
        staleFiles.push(f);
        return false;
    });
    if (staleFiles.length > 0) console.warn(`[FUSION] ⚠️ Skipping ${staleFiles.length} stale shard(s)`);
    if (shardFiles.length < expectedIndices.size) {
        const missing = [...expectedIndices].filter(i => !shardFiles.some(f => parseInt(f.match(/part-(\d+)/)?.[1] ?? '-1') === i));
        throw new Error(`[FUSION] CRITICAL: ${expectedIndices.size} expected, ${shardFiles.length} present. Missing: ${missing.slice(0, 10)}`);
    }
    const outDir = path.join(CONFIG.CACHE_DIR, 'fused');
    await fs.mkdir(outDir, { recursive: true });
    console.log(`[FUSION] Phase 4: Fusing ${shardFiles.length} shards...`);
    console.log(`  [DIAG] enrich=${entityEnrichMap.size}, cold=${coldBodyMap.size}`);
    let totalEnriched = 0, totalDl = 0, totalNeeded = 0, totalMissingShard = 0;
    let processedCount = 0;
    const DL_CONCURRENCY = 100;

    // §18.22.4: Three-layer silent early-exit defense (see fusion-completion-guard.js).
    const expectedFusionCount = shardFiles.length;
    const exitGuard = installExitGuard(() => ({ processed: processedCount, expected: expectedFusionCount }));

    for (let i = 0; i < shardFiles.length; i++) {
        const shardPath = path.join(CONFIG.ARTIFACT_DIR, shardFiles[i]);
        const outPath = path.join(outDir, `part-${String(i).padStart(3, '0')}.json.zst`);
        const shardIdx = parseInt(shardFiles[i].match(/part-(\d+)/)[1]);

        // A3: Write cold bodies to enrichmentDir for entities WITHOUT enrichment
        let coldWritten = 0;
        if (coldBodyMap.size > 0) {
            const entityIds = shardEntityIds.get(shardIdx) || [];
            for (const id of entityIds) {
                if (!entityEnrichMap.has(id) && coldBodyMap.has(id)) {
                    const umid = generateUMID(id);
                    try {
                        await fs.writeFile(path.join(enrichmentDir, `${umid}.md.gz`), Buffer.from(coldBodyMap.get(id), 'utf-8'));
                        coldWritten++;
                    } catch { }
                }
            }
        }

        // V26.8: Per-shard download using pre-built mapping (no shard read needed)
        let dlCount = 0;
        if (r2 && entityEnrichMap.size > 0) {
            const entityIds = shardEntityIds.get(shardIdx) || [];
            if (entityIds.length === 0 && i < 3) {
                console.warn(`  [DIAG] Shard ${shardIdx} (file=${shardFiles[i]}): shardEntityIds returned EMPTY — index mismatch?`);
                totalMissingShard++;
            }
            const needed = [];
            for (const id of entityIds) {
                const r2Umid = entityEnrichMap.get(id);
                if (r2Umid && enrichmentMap.has(r2Umid)) {
                    const prodUmid = generateUMID(id);
                    needed.push([prodUmid, enrichmentMap.get(r2Umid)]);
                }
            }
            totalNeeded += needed.length;
            if (needed.length > 0) {
                // Write manifest for Rust fusion (entity_id → prod umid)
                const manifest = {};
                for (const id of entityIds) {
                    if (entityEnrichMap.has(id)) manifest[id] = generateUMID(id);
                }
                await fs.writeFile(path.join(enrichmentDir, 'manifest.json'), JSON.stringify(manifest));

                for (let j = 0; j < needed.length; j += DL_CONCURRENCY) {
                    const batch = needed.slice(j, j + DL_CONCURRENCY);
                    const results = await Promise.allSettled(batch.map(async ([umid, key]) => {
                        for (let attempt = 0; attempt < 3; attempt++) {
                            try {
                                const raw = await downloadBufferFromR2FFI(r2, key);
                                await fs.writeFile(path.join(enrichmentDir, `${umid}.md.gz`), raw);
                                return;
                            } catch (e) {
                                if (attempt === 2) throw e;
                                await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
                            }
                        }
                    }));
                    const failed = results.filter(r => r.status === 'rejected');
                    dlCount += results.length - failed.length;
                    if (failed.length > 0 && i < 3) {
                        console.warn(`  [DIAG] Shard ${i} batch ${j}: ${failed.length}/${batch.length} failed — ${failed[0].reason?.message || failed[0].reason}`);
                    }
                }
                totalDl += dlCount;
            }
        }

        try {
            const result = fuseShardFFI(shardPath, validIdsPath, thresholdsPath, enrichmentDir, outPath);
            if (result) {
                totalEnriched += result.enrichedCount;
                console.log(`  [OK] Shard ${i}/${shardFiles.length}: ${result.entityCount} entities (Rust, ${dlCount} dl, ${coldWritten} cold, ${result.enrichedCount} enriched)`);
            } else {
                const fused = await fuseShardJS(shardPath, allValidIds, fniThresholds, entityEnrichMap, enrichmentDir);
                await fs.writeFile(outPath, await zstdCompress(JSON.stringify({
                    shardId: i, entities: fused, _ts: new Date().toISOString()
                })));
                console.log(`  [OK] Shard ${i}/${shardFiles.length}: ${fused.length} entities (JS)`);
            }
            processedCount++;
        } catch (e) {
            console.error(`  [FAIL] Shard ${i}: ${e.message}`);
        }
        // Cleanup per-shard enrichment to avoid disk bloat (O(1) disk)
        const files = await fs.readdir(enrichmentDir).catch(() => []);
        await Promise.all(files.map(f => fs.unlink(path.join(enrichmentDir, f)).catch(() => {})));
        if (global.gc && i % 10 === 9) global.gc();
    }

    assertCompletion(processedCount, expectedFusionCount);

    shardEntityIds.clear(); entityEnrichMap.clear(); enrichmentMap.clear(); coldBodyMap.clear();
    await fs.unlink(validIdsPath).catch(() => {});
    await fs.rm(enrichmentDir, { recursive: true }).catch(() => {});
    process.removeListener('exit', exitGuard);
    await writeSentinel(outDir, { processedShards: processedCount, expectedShards: expectedFusionCount, enriched: totalEnriched, downloaded: totalDl });

    console.log(`[FUSION V26.8] Complete! ${processedCount}/${expectedFusionCount} shards, ${totalDl} dl, ${totalEnriched} enriched`);
}

main().catch(err => { console.error('[CRITICAL] Fusion:', err); process.exit(1); });
