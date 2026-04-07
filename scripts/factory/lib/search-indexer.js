/**
 * Search Indexer Module V25.9
 * Constitution Reference: Art 6.3 (Dual Search Index)
 * V25.9: Streaming — Rust FFI primary, JS bounded core + streaming shards.
 */

import fs from 'fs/promises';
import path from 'path';
import { smartWriteWithVersioning } from './smart-writer.js';
import { zstdCompress } from './zstd-helper.js';
import { buildSearchIndexFromDirFFI, buildSearchIndexFFI } from './rust-bridge.js';

const SEARCH_CORE_SIZE = 5000;
const SHARD_SIZE = 5000;

/**
 * Generate dual search indices via streaming shard reader (Art 6.3)
 */
export async function generateSearchIndices(shardReader, outputDir = './output', opts = {}) {
    console.log('[SEARCH] Generating search indices (streaming)...');

    const searchDir = path.join(outputDir, 'cache');
    await fs.mkdir(searchDir, { recursive: true });

    // V26.5: Try Rust direct shard reading first (no V8 string limit)
    const shardDir = opts?.shardDir;
    let rustResult = null;
    if (shardDir) rustResult = buildSearchIndexFromDirFFI(shardDir, searchDir);
    if (rustResult?.core_data && rustResult?.shards) {
        console.log(`[SEARCH] Rust FFI: ${rustResult.total_entities} entities, ${rustResult.shards.length} shards`);
        await fs.writeFile(path.join(searchDir, 'search-core.json.zst'), Buffer.from(rustResult.core_data));
        const shardingDir = path.join(searchDir, 'search');
        await fs.mkdir(shardingDir, { recursive: true });
        for (const shard of rustResult.shards) {
            await fs.writeFile(path.join(shardingDir, `shard-${shard.shard_index}.json.zst`), Buffer.from(shard.compressed_data));
        }
        await fs.writeFile(path.join(searchDir, 'search-manifest.json'), rustResult.manifest_json);
        console.log(`  [SEARCH] ✅ Done (Rust). ${rustResult.shards.length} shards generated.`);
        return;
    }

    // JS streaming fallback: single pass — bounded core + streaming shard writes
    const shardingDir = path.join(searchDir, 'search');
    await fs.mkdir(shardingDir, { recursive: true });

    const coreAccum = [];
    let shardBuffer = [];
    let shardIdx = 0;
    let totalEntities = 0;

    await shardReader(async (entities) => {
        for (const e of entities) {
            totalEntities++;
            const projected = projectForSearch(e);

            // Core: bounded top-5000 by FNI
            if (coreAccum.length < SEARCH_CORE_SIZE) {
                coreAccum.push(projected);
                if (coreAccum.length === SEARCH_CORE_SIZE) coreAccum.sort(byFniDesc);
            } else if ((projected.fni_score || 0) > (coreAccum[coreAccum.length - 1].fni_score || 0)) {
                coreAccum[coreAccum.length - 1] = projected;
                coreAccum.sort(byFniDesc);
            }

            // Full index: stream-write shards at SHARD_SIZE boundary
            shardBuffer.push(projected);
            if (shardBuffer.length >= SHARD_SIZE) {
                await writeSearchShard(shardIdx++, shardBuffer, shardingDir);
                shardBuffer = [];
            }
        }
    }, { slim: true });

    // Flush remaining shard buffer
    if (shardBuffer.length > 0) await writeSearchShard(shardIdx++, shardBuffer, shardingDir);
    const totalShards = shardIdx;

    // Write core index
    coreAccum.sort(byFniDesc);
    await smartWriteWithVersioning('search-core.json', coreAccum, searchDir, { compress: true });
    console.log(`  [SEARCH] Core index: ${coreAccum.length} entities`);

    // Manifest
    await fs.writeFile(path.join(searchDir, 'search-manifest.json'), JSON.stringify({
        totalEntities, totalShards, shardSize: SHARD_SIZE,
        extension: '.zst', _generated: new Date().toISOString(),
    }));

    console.log(`  [SEARCH] ✅ Done. ${totalShards} shards, ${totalEntities} entities.`);
}

function projectForSearch(e) {
    return {
        id: e.id, name: e.name || e.slug || 'Unknown', type: e.type || 'model',
        author: e.author || '', description: (e.description || e.summary || '').substring(0, 150),
        tags: Array.isArray(e.tags) ? e.tags.slice(0, 5) : [],
        fni_score: Math.round(e.fni_score || 0), image_url: e.image_url || null,
        slug: e.slug || e.id?.split(/[:/]/).pop(),
        params_billions: e.params_billions ?? e.params ?? e.technical?.parameters_b ?? 0,
        context_length: e.context_length ?? e.technical?.context_length ?? 0,
        stars: e.stars || 0, downloads: e.downloads || 0,
        fni_s: e.fni_s ?? e.fni_metrics?.s ?? 50.0, fni_a: e.fni_a ?? e.fni_metrics?.a ?? 0,
        fni_p: e.fni_p ?? e.fni_metrics?.p ?? 0, fni_r: e.fni_r ?? e.fni_metrics?.r ?? 0,
        fni_q: e.fni_q ?? e.fni_metrics?.q ?? 0,
        bundle_key: e.bundle_key || '', bundle_offset: e.bundle_offset ?? 0, bundle_size: e.bundle_size ?? 0
    };
}

async function writeSearchShard(idx, entities, dir) {
    const shard = { shard: idx, entities, _count: entities.length, _generated: new Date().toISOString() };
    await fs.writeFile(path.join(dir, `shard-${idx}.json.zst`), await zstdCompress(JSON.stringify(shard)));
}

function byFniDesc(a, b) { return (b.fni_score || 0) - (a.fni_score || 0); }
