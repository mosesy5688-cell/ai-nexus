/**
 * Registry Consolidator V55.9
 *
 * Consolidates natural shards (1000 entities each, from 1/4 Harvest)
 * into 20 hash-routed processing shards for the 2/4 matrix pipeline.
 * Replaces the V22.2 monolith splitter — monolith no longer exists.
 *
 * Input:  data/merged_shard_*.json.zst (natural shards from merge-batches)
 * Output: data/merged_shard_0..19.json.zst (hash-routed processing shards)
 */

import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { initRustBridge, computeShardSlotFFI } from './lib/rust-bridge.js';
import { zstdCompress, autoDecompress, createZstdCompressStream } from './lib/zstd-helper.js';

const TOTAL_SHARDS = 20;
const DATA_DIR = 'data';

const rustStatus = initRustBridge();
console.log(`[CONSOLIDATOR] Rust FFI: ${rustStatus.mode} (${rustStatus.modules.join(', ') || 'JS fallback'})`);

function getShardFromId(id, total) {
    if (!id) return 0;
    return computeShardSlotFFI(id, total);
}

async function consolidateShards() {
    console.log(`\n🔪 [Consolidator] Consolidating natural shards → ${TOTAL_SHARDS} processing shards...`);

    const allFiles = await fsp.readdir(DATA_DIR);
    const naturalShards = allFiles
        .filter(f => f.startsWith('merged_shard_') && f.endsWith('.json.zst'))
        .sort((a, b) => {
            const numA = parseInt(a.match(/\d+/)?.[0] || '0');
            const numB = parseInt(b.match(/\d+/)?.[0] || '0');
            return numA - numB;
        });

    if (naturalShards.length === 0) {
        console.error(`❌ [Consolidator] No natural shards (merged_shard_*.json.zst) found in ${DATA_DIR}/`);
        process.exit(1);
    }

    console.log(`   📂 Found ${naturalShards.length} natural shards from 1/4 Harvest`);
    const startTime = Date.now();

    // V55.9: Init Zstd codec (Rust FFI or WASM warmup)
    await zstdCompress(Buffer.from('init'));

    // Open 20 output streams — write to temp names to avoid collision with input
    const shardCounts = new Array(TOTAL_SHARDS).fill(0);
    const outStreams = Array.from({ length: TOTAL_SHARDS }, (_, i) => {
        const zst = createZstdCompressStream();
        const ws = fs.createWriteStream(path.join(DATA_DIR, `proc_shard_${i}.json.zst`));
        zst.pipe(ws);
        zst.write('[');
        return { zst, ws };
    });

    let totalCount = 0;

    // Process each natural shard: decompress → parse → hash-route → write
    for (const file of naturalShards) {
        const filePath = path.join(DATA_DIR, file);
        const raw = await fsp.readFile(filePath);
        const decompressed = await autoDecompress(raw);
        let entities;
        try {
            entities = JSON.parse(decompressed.toString('utf-8'));
        } catch (e) {
            console.warn(`   ⚠️ Skipping corrupt shard ${file}: ${e.message}`);
            continue;
        }

        for (const entity of entities) {
            const shardIdx = getShardFromId(entity.id || entity.slug, TOTAL_SHARDS);
            const prefix = shardCounts[shardIdx] === 0 ? '' : ',';
            outStreams[shardIdx].zst.write(prefix + JSON.stringify(entity));
            shardCounts[shardIdx]++;
            totalCount++;
        }

        if (totalCount % 50000 === 0 || file === naturalShards[naturalShards.length - 1]) {
            const mem = Math.round(process.memoryUsage().heapUsed / 1048576);
            console.log(`   - ${totalCount} entities routed (${file}) [Heap: ${mem}MB]`);
        }
    }

    // Close all output streams
    for (let i = 0; i < TOTAL_SHARDS; i++) {
        outStreams[i].zst.write(']');
        outStreams[i].zst.end();
    }

    // Wait for all file streams to finish
    await Promise.all(outStreams.map(s =>
        new Promise(resolve => s.ws.on('finish', resolve))
    ));

    // Remove natural shards, rename proc shards to final names
    for (const file of naturalShards) {
        await fsp.unlink(path.join(DATA_DIR, file)).catch(() => {});
    }
    for (let i = 0; i < TOTAL_SHARDS; i++) {
        await fsp.rename(
            path.join(DATA_DIR, `proc_shard_${i}.json.zst`),
            path.join(DATA_DIR, `merged_shard_${i}.json.zst`)
        );
    }

    // Integrity check
    const sumCount = shardCounts.reduce((a, b) => a + b, 0);
    console.log(`\n⚖️ [Consolidator] Integrity Verification:`);
    console.log(`   - Input: ${naturalShards.length} natural shards`);
    console.log(`   - Total entities routed: ${totalCount}`);
    console.log(`   - Output: ${TOTAL_SHARDS} processing shards`);

    if (sumCount !== totalCount || totalCount === 0) {
        console.error(`   ❌ CRITICAL: Integrity Violation! Routed ${sumCount} vs processed ${totalCount}`);
        process.exit(1);
    }

    if (totalCount < 85000) {
        console.error(`   ❌ CRITICAL: Entity count ${totalCount} below 85k baseline!`);
        process.exit(1);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const dist = shardCounts.map((c, i) => `s${i}:${c}`).join(' ');
    console.log(`   Distribution: ${dist}`);
    console.log(`✅ [Consolidator] Complete in ${duration}s. ${totalCount} entities → ${TOTAL_SHARDS} shards.`);
}

consolidateShards().catch(err => {
    console.error(`\n❌ [FATAL] ${err.message}`);
    process.exit(1);
});
