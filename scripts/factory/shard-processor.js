/**
 * Factory Shard Processor V56.2 (CES Compliant)
 *
 * Constitution: Art 3.1-3.4 (Factory Pipeline)
 * V56.2: Removed V25.8 Pulse Sync cursor resume — V56.1 streaming made shards fast
 *        (4-10s each), resume was designed for hours-long shards that no longer exist.
 *        Stale cursors from prior runs were silently skipping 90% of new data per shard
 *        because Consolidator regenerates `merged_shard_*.json.zst` every cycle but the
 *        cursor had no invalidation. Every run now processes the full consolidated shard.
 *
 * Usage: node scripts/factory/shard-processor.js --shard=N --total=20
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import readline from 'readline';
import { once } from 'events';
import { processEntity } from './lib/processor-core.js';
import { zstdCompress, autoDecompress, createZstdCompressStream, createAutoDecompressStream } from './lib/zstd-helper.js';
import { loadEntityChecksums, loadDailyAccum, loadFniHistory } from './lib/cache-manager.js';
import { normalizeId, getNodeSource } from '../utils/id-normalizer.js';
import { initR2Bridge, createR2ClientFFI, downloadFromR2FFI } from './lib/r2-bridge.js';
import { initRustBridge } from './lib/rust-bridge.js';

// Configuration (Art 3.1)
const CONFIG = {
    TOTAL_SHARDS: 20,
    CACHE_DIR: process.env.CACHE_DIR || './cache',
    ARTIFACT_DIR: './artifacts'
};

/**
 * Utility: Parse CLI arguments (Art 3.1)
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const shard = args.find(a => a.startsWith('--shard='))?.split('=')[1];
    const total = args.find(a => a.startsWith('--total='))?.split('=')[1];
    return {
        shardId: parseInt(shard) || 0,
        totalShards: parseInt(total) || 20
    };
}

// Main (V14.5.2: with artifact-based checksum tracking)
async function main() {
    const { shardId, totalShards } = parseArgs();
    console.log(`[SHARD ${shardId}/${totalShards}] Starting...`);

    // R2 client is used only for the consolidated-shard R2 fallback in ensureLocalShard().
    // V56.2: Pulse Sync cursor resume was removed — every run processes the full shard.
    initR2Bridge();
    initRustBridge();
    const r2 = createR2ClientFFI();

    // V16.2.10: Data Safety Guard - 2/4 stage must not back up shard data to R2
    process.env.ENABLE_R2_BACKUP = 'false';

    // V16.11: Load global context
    const [globalStats, entityChecksums, fniHistory] = await Promise.all([
        loadDailyAccum(),
        loadEntityChecksums(),
        loadFniHistory()
    ]);

    // V56.0: Streaming NDJSON shard reader (Rust FFI decompress + readline).
    // The processing shards (~30-100MB compressed → 300-600MB raw) routinely exceed
    // V8's 512 MiB single-string limit, which broke the legacy
    // `readFile → autoDecompress → toString → JSON.parse` path and silently fell
    // back to a deleted monolith, returning 0 entities. We now stream through
    // Rust zstdDecompressFile and parse one JSON object per line.
    const shardFilePath = path.join(CONFIG.CACHE_DIR, `merged_shard_${shardId}.json.zst`);

    // V56.0: R2-primary fallback. If the local shard is missing (cache miss with no
    // R2 cache fallback in workflow), pull it directly from the Consolidator's
    // R2 upload prefix via Rust streaming download (writes to disk, O(1) memory).
    async function ensureLocalShard() {
        if (await fs.stat(shardFilePath).catch(() => null)) return true;
        console.warn(`[SHARD ${shardId}] ⚠️ Local shard missing (${shardFilePath}). Attempting R2 fallback...`);
        if (!r2) {
            throw new Error(`Shard input missing and R2 client unavailable — cannot proceed for shard ${shardId}`);
        }
        const r2Key = `state/processing-shards/merged_shard_${shardId}.json.zst`;
        await fs.mkdir(path.dirname(shardFilePath), { recursive: true });
        const result = await downloadFromR2FFI(r2, r2Key, shardFilePath);
        if (!result || result.success === false) {
            throw new Error(`R2 download failed for ${r2Key} — shard ${shardId} cannot be processed`);
        }
        const stat = await fs.stat(shardFilePath).catch(() => null);
        if (!stat || stat.size === 0) {
            throw new Error(`R2 downloaded ${r2Key} but file is empty — refusing silent zero-entity run`);
        }
        console.log(`[SHARD ${shardId}] ✓ Restored from R2 (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
        return true;
    }

    await ensureLocalShard();

    // V18.12.5.21: Industrial Streaming Output (Art 3.4) — open BEFORE the read loop
    // so the read→process→write pipeline runs end-to-end without buffering entities.
    const outPath = path.join(CONFIG.ARTIFACT_DIR, `shard-${shardId}.json.zst`);
    await fs.mkdir(CONFIG.ARTIFACT_DIR, { recursive: true });

    // V25.9: Init Zstd codec, create Zstd compress stream
    await zstdCompress(Buffer.from('init'));
    const outStream = createZstdCompressStream();
    const fileStream = (await import('fs')).createWriteStream(outPath);
    outStream.pipe(fileStream);

    // Header
    outStream.write('{\n"shardId":' + shardId + ',\n"entities":[\n');

    // V56.1: True end-to-end streaming pipeline.
    // read NDJSON line → parse → processEntity → write → release.
    // Memory is O(1 entity) regardless of shard size, so this scales from
    // 22k entities/shard (current) to 500k+ entities/shard without OOM.
    console.log(`[SHARD ${shardId}] Streaming entities from ${shardFilePath}...`);
    const fileRs = fsSync.createReadStream(shardFilePath);
    const decompStream = createAutoDecompressStream();
    fileRs.on('error', e => { console.error(`[SHARD ${shardId}] Read stream error: ${e.message}`); process.exit(1); });
    decompStream.on('error', e => { console.error(`[SHARD ${shardId}] Decompress error: ${e.message}`); process.exit(1); });
    outStream.on('error', e => { console.error(`[SHARD ${shardId}] Write stream error: ${e.message}`); process.exit(1); });
    const rl = readline.createInterface({
        input: fileRs.pipe(decompStream),
        crlfDelay: Infinity
    });

    // Backpressure-aware write helper: respect outStream.write() returning false.
    const safeWrite = async (chunk) => {
        if (!outStream.write(chunk)) await once(outStream, 'drain');
    };

    let entityIndex = 0;       // total lines seen on the input stream (for zero-loss guard)
    let processedCount = 0;    // entities actually processed in this run
    let successCount = 0;
    let writtenCount = 0;      // entities serialized to outStream (for comma framing)
    const startTime = Date.now();

    for await (const line of rl) {
        if (!line) continue;

        let entity;
        try {
            entity = JSON.parse(line);
        } catch (e) {
            console.warn(`[SHARD ${shardId}] ⚠️ Skipping malformed NDJSON line (${e.message}): ${line.slice(0, 120)}`);
            entityIndex++;
            continue;
        }

        try {
            const result = await processEntity(entity, globalStats, entityChecksums, fniHistory, CONFIG);

            if (result.success) successCount++;
            processedCount++;

            const comma = writtenCount === 0 ? '' : ',\n';
            await safeWrite(comma + JSON.stringify(result));
            writtenCount++;

            if (processedCount % 500 === 0) {
                const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0);
                console.log(`[SHARD ${shardId}] Progress: ${processedCount} processed (RAM: ${mem}MB)...`);
                if (global.gc) global.gc();
            }
        } catch (e) {
            console.error(`[SHARD ${shardId}] Error processing ${entity?.id}:`, e.message);
            processedCount++;
        }

        entityIndex++;
    }

    // V56.2: Hard fail on zero entities — never silently produce empty shards.
    // entityIndex == 0 means the input stream produced no parseable lines at all
    // (truly broken). processedCount == 0 with lines seen means every entity
    // errored in processEntity — also a silent loss scenario.
    if (entityIndex === 0) {
        throw new Error(`Shard ${shardId} streamed 0 entities from ${shardFilePath} — refusing silent loss`);
    }
    if (processedCount === 0) {
        throw new Error(`Shard ${shardId} processed 0 entities (saw ${entityIndex} lines) — refusing silent loss`);
    }

    // Footer
    const timestamp = new Date().toISOString();
    await safeWrite(`\n],\n"timestamp":"${timestamp}",\n"processedCount":${processedCount},\n"successCount":${successCount},\n"totalSeen":${entityIndex},\n"version":"56.2-streaming"\n}`);

    // Finalize
    outStream.end();

    return new Promise((resolve) => {
        fileStream.on('finish', () => {
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            const stats = (fsSync.statSync(outPath).size / 1024 / 1024).toFixed(2);
            console.log(`[SHARD ${shardId}] ✅ Complete. Written to ${outPath} (${stats} MB) in ${duration}s`);
            resolve();
        });
    });
}

main().catch(err => {
    console.error('Fatal Shard Error:', err);
    process.exit(1);
});
