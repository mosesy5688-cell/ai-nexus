/**
 * Registry Consolidator V56.0 (NDJSON Streaming)
 *
 * Consolidates natural shards (1000 entities each, from 1/4 Harvest)
 * into 20 hash-routed processing shards for the 2/4 matrix pipeline.
 * Replaces the V22.2 monolith splitter — monolith no longer exists.
 *
 * V56.0: Output is NDJSON (one entity per line) inside Zstd, so the
 * shard-processor reader can stream entities line-by-line via Rust FFI
 * decompression + readline, never loading the full payload into a single
 * V8 string (which caps at 512 MiB).
 *
 * Input:  data/merged_shard_*.json.zst (natural shards from merge-batches, NDJSON since V56.1)
 * Output: data/merged_shard_0..19.json.zst (hash-routed processing shards, NDJSON)
 */

import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { initRustBridge, computeShardSlotFFI } from './lib/rust-bridge.js';
import { zstdCompress, createZstdCompressStream, createAutoDecompressStream } from './lib/zstd-helper.js';
import { initR2Bridge, createR2ClientFFI, uploadFileFFI, uploadFileMultipartFFI } from './lib/r2-bridge.js';

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
    // V56.0: NDJSON format — no array brackets, one JSON object per line.
    const shardCounts = new Array(TOTAL_SHARDS).fill(0);
    const outStreams = Array.from({ length: TOTAL_SHARDS }, (_, i) => {
        const zst = createZstdCompressStream();
        const ws = fs.createWriteStream(path.join(DATA_DIR, `proc_shard_${i}.json.zst`));
        zst.pipe(ws);
        return { zst, ws };
    });

    let totalCount = 0;

    // V56.2: End-to-end file-stream + Rust FFI decompress + readline.
    // Never materialize the full decompressed payload as a single V8 string
    // (caps at 0x1fffffe8 / ~512 MiB). Mirrors shard-processor.js §119-123.
    //
    // Why not Readable.from(buffer)? It emits the entire buffer as ONE data
    // event, so readline's StringDecoder tries to decode ~500MB in one call
    // and hits the V8 string limit (observed crash at shard 250, run post-PR #1751).
    //
    // fs.createReadStream emits 64KB chunks → decompress stream → readline,
    // so StringDecoder never accumulates more than a line's worth.
    for (const file of naturalShards) {
        const filePath = path.join(DATA_DIR, file);
        const fileRs = fs.createReadStream(filePath);
        const decompStream = createAutoDecompressStream();
        const rl = readline.createInterface({
            input: fileRs.pipe(decompStream),
            crlfDelay: Infinity,
        });

        let skipped = 0;
        let firstLineSeen = false;
        let legacyEntities = null;

        for await (const line of rl) {
            if (!line) continue;

            // Detect legacy JSON-array format on first non-empty line (starts with '[').
            // Legacy shards are pre-V56.1 and fit in a single V8 string by construction
            // (natural shards capped at 1000 entities ≈ well under 512MB).
            if (!firstLineSeen) {
                firstLineSeen = true;
                if (line.trimStart().startsWith('[')) {
                    // Collect remaining lines, parse as one array below.
                    legacyEntities = [line];
                    continue;
                }
            }
            if (legacyEntities) {
                legacyEntities.push(line);
                continue;
            }

            let entity;
            try {
                entity = JSON.parse(line);
            } catch {
                skipped++;
                continue;
            }
            const shardIdx = getShardFromId(entity.id || entity.slug, TOTAL_SHARDS);
            outStreams[shardIdx].zst.write(JSON.stringify(entity) + '\n');
            shardCounts[shardIdx]++;
            totalCount++;
        }

        if (legacyEntities) {
            try {
                const arr = JSON.parse(legacyEntities.join('\n'));
                for (const entity of arr) {
                    const shardIdx = getShardFromId(entity.id || entity.slug, TOTAL_SHARDS);
                    outStreams[shardIdx].zst.write(JSON.stringify(entity) + '\n');
                    shardCounts[shardIdx]++;
                    totalCount++;
                }
            } catch (e) {
                console.warn(`   ⚠️ Skipping corrupt legacy shard ${file}: ${e.message}`);
            }
        }
        if (skipped > 0) {
            console.warn(`   ⚠️ Skipped ${skipped} malformed NDJSON line(s) in ${file}`);
        }

        if (totalCount % 50000 === 0 || file === naturalShards[naturalShards.length - 1]) {
            const mem = Math.round(process.memoryUsage().heapUsed / 1048576);
            console.log(`   - ${totalCount} entities routed (${file}) [Heap: ${mem}MB]`);
        }
    }

    // Close all output streams
    for (let i = 0; i < TOTAL_SHARDS; i++) {
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

    // V56.0: R2-primary upload of processing shards (durable cross-job transport).
    // Matrix shard jobs will fall back to this prefix if GHA cache misses.
    initR2Bridge();
    const r2 = createR2ClientFFI();
    if (r2) {
        console.log(`\n☁️ [Consolidator] Uploading processing shards to R2 (state/processing-shards/)...`);
        let uploaded = 0, failed = 0;
        for (let i = 0; i < TOTAL_SHARDS; i++) {
            const localPath = path.join(DATA_DIR, `merged_shard_${i}.json.zst`);
            const r2Key = `state/processing-shards/merged_shard_${i}.json.zst`;
            try {
                const stat = await fsp.stat(localPath);
                // Use multipart for >8MB; processing shards are typically 30-100MB
                if (stat.size > 8 * 1024 * 1024) {
                    await uploadFileMultipartFFI(r2, localPath, r2Key);
                } else {
                    await uploadFileFFI(r2, localPath, r2Key, null);
                }
                uploaded++;
            } catch (e) {
                console.warn(`   ⚠️ R2 upload failed for shard ${i}: ${e.message}`);
                failed++;
            }
        }
        console.log(`   ☁️ R2 upload: ${uploaded}/${TOTAL_SHARDS} succeeded, ${failed} failed`);
        if (failed > 0) {
            console.warn(`   ⚠️ Some shards not on R2 — matrix jobs will rely on GHA cache only`);
        }
    } else {
        console.warn(`   ⚠️ R2 client unavailable — skipping R2 upload (matrix jobs will rely on cache)`);
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
