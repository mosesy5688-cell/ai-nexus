#!/usr/bin/env node
/**
 * merge-batches.js
 *
 * Phase A.3: Merge batch files from parallel harvester jobs
 * V55.9: Iterative flush + natural sharding (1000 entities/shard, Zstd)
 *
 * Usage: node scripts/ingestion/merge-batches.js
 */

import { promises as fs, createWriteStream } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { once } from 'events';
import { mergeEntities } from './lib/entity-merger.js';
import { zstdCompress, createZstdCompressStream } from '../factory/lib/zstd-helper.js';
import { loadEntityChecksums, saveEntityChecksums } from '../factory/lib/cache-manager.js';
import { RegistryManager } from '../factory/lib/registry-manager.js';
import { finalizeMerge } from './lib/manifest-helper.js';
import { normalizeId, getNodeSource } from '../utils/id-normalizer.js';

const DATA_DIR = 'data';
const MANIFEST_FILE = 'data/manifest.json';
const SHARD_SIZE = 1000;

// Validation Constants (L1 Logic)
const MAX_BATCH_SIZE_MB = 50;
const MAX_ENTITIES_PER_BATCH = 15000;

function calculateHash(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

async function mergeBatches() {
    const files = await fs.readdir(DATA_DIR);
    const batchFiles = files.filter(f => f.startsWith('raw_batch_') && f.endsWith('.json'));

    // V22.7: Load Deduplication Map EARLY for persistent canonical ID mapping
    let dedupMap = {};
    const fsSync = await import('fs');
    try {
        const dedupPath = path.join(process.cwd(), 'public/api/cache/deduplication-map.json');
        if (fsSync.existsSync(dedupPath)) {
            const dedupData = JSON.parse(fsSync.readFileSync(dedupPath, 'utf8'));
            dedupMap = dedupData.canonical_map || {};
            console.log(`   🔗 [Merge] Loaded deduplication map with ${Object.keys(dedupMap).length} entries.`);
        }
    } catch (e) {
        console.warn(`   ⚠️ [Merge] Failed to load deduplication map: ${e.message}`);
    }

    if (batchFiles.length === 0) {
        console.log('⚠️ No batch files found in data/');
        return { total: 0, sources: [] };
    }

    const sourceStats = [];
    const batchManifests = [];

    // V55.9: Iterative Flush — merge each batch directly into SQLite
    const registryManager = new RegistryManager();
    await registryManager.load();
    let registryState;

    for (const file of batchFiles) {
        const filePath = path.join(DATA_DIR, file);
        try {
            // V55.9: Use let for explicit release after SQLite flush
            let content = await fs.readFile(filePath, 'utf-8');
            const stats = await fs.stat(filePath);
            const batchHash = calculateHash(content);
            let entities = JSON.parse(content);
            content = null; // Release raw string immediately

            batchManifests.push({
                name: file,
                size: stats.size,
                count: entities.length,
                hash: `sha256:${batchHash}`
            });

            // V22.7: Apply Deduplication Mapping BEFORE merging
            for (const entity of entities) {
                if (!entity.id) continue;
                const dedupEntry = dedupMap[entity.id] || dedupMap[entity.canonical_id];
                if (dedupEntry) {
                    entity.canonical_id = dedupEntry.canonical_id;
                }
                if (entity.source_trail && typeof entity.source_trail !== 'string') {
                    entity.source_trail = JSON.stringify(entity.source_trail);
                }
            }

            // Flush this batch directly to SQLite (O(B) memory per batch)
            const validEntities = entities.filter(e => e.id);
            entities = null; // Release full array before merge
            registryState = await registryManager.mergeCurrentBatch(validEntities);

            const sourceName = file.replace('raw_batch_', '').replace('.json', '');
            sourceStats.push({ source: sourceName, count: registryState.added, file });

            // V55.9: Memory pressure logging + aggressive GC
            const mem = process.memoryUsage();
            const heapMB = Math.round(mem.heapUsed / 1048576);
            const rssMB = Math.round(mem.rss / 1048576);
            console.log(`   ✓ ${sourceName}: ${registryState.added} new | ${registryState.updated} augmented [Heap: ${heapMB}MB | RSS: ${rssMB}MB]`);

            if (global.gc) { global.gc(); global.gc(); }
        } catch (error) {
            console.error(`   ❌ Error reading ${file}: ${error.message}`);
        }
    }

    const checksums = await loadEntityChecksums();
    await saveEntityChecksums(checksums);

    if (!registryState.didLoadFromStorage && process.env.GITHUB_ACTIONS) {
        throw new Error(`Registry Load Failure - Emergency Abort to Protect 85k Baseline`);
    }

    if (registryState.count < 85000) {
        throw new Error(`CRITICAL: Entity count dropped to ${registryState.count} (Expected >85k).`);
    }

    // V56.1: NDJSON streaming export — 1000 entities/shard, per-entity write,
    // Rust FFI zstd stream. O(1) memory per entity (was: O(shard) mega-array
    // + JSON.stringify hitting V8 512MB string limit at ~260 shards, see §18.22).
    console.log(`\n🛡️ [Merge] Exporting via natural sharding (${SHARD_SIZE}/shard, NDJSON+Zstd stream)...`);
    await zstdCompress(Buffer.from('init')); // Warm up codec (Rust or WASM)

    let exportedCount = 0;
    let totalVelocity = 0;
    let compressedSize = 0;
    let shardIndex = 0;
    let entitiesInShard = 0;
    const hash = crypto.createHash('sha256');

    let currentShardFile = null;
    let currentZst = null;
    let currentWs = null;

    const openShard = () => {
        currentShardFile = path.join(DATA_DIR, `merged_shard_${shardIndex}.json.zst`);
        currentZst = createZstdCompressStream();
        currentWs = createWriteStream(currentShardFile);
        currentZst.pipe(currentWs);
        entitiesInShard = 0;
    };

    const closeShard = async () => {
        if (!currentZst) return;
        currentZst.end();
        await once(currentWs, 'finish');
        const stat = await fs.stat(currentShardFile);
        const compressedBuf = await fs.readFile(currentShardFile);
        hash.update(compressedBuf);
        compressedSize += stat.size;
        shardIndex++;
        currentShardFile = null;
        currentZst = null;
        currentWs = null;
    };

    openShard();

    const iterator = registryManager.getStreamingIterator('id ASC');
    for (const entity of iterator) {
        const oldId = entity.id;
        const source = entity.source || getNodeSource(oldId, entity.type);
        const newId = normalizeId(oldId, source, entity.type);
        const scrubbed = { ...entity, id: newId };

        // V56.1: Per-entity NDJSON write — single entity JSON never exceeds V8 string limit.
        if (!currentZst.write(JSON.stringify(scrubbed) + '\n')) {
            await once(currentZst, 'drain');
        }
        totalVelocity += (scrubbed.velocity || 0);
        exportedCount++;
        entitiesInShard++;

        if (entitiesInShard >= SHARD_SIZE) {
            await closeShard();
            openShard();
        }

        if (exportedCount % 10000 === 0) {
            console.log(`   - Exported ${exportedCount} entities (${shardIndex} shards)...`);
        }
    }
    await closeShard();

    const mergedHash = hash.digest('hex');
    console.log(`\n✅ [Merge] Complete: ${exportedCount} entities → ${shardIndex} shards`);

    await finalizeMerge({
        manifestFile: MANIFEST_FILE,
        outputFile: `data/merged_shard_*.json.zst`,
        mergedContent: null,
        mergedHash,
        allEntitiesCount: exportedCount,
        batchManifests,
        sourceStats,
        batchFilesCount: batchFiles.length,
        fullSet: [],
        avgVelocityOverride: totalVelocity / (exportedCount || 1),
        MAX_BATCH_SIZE_MB,
        MAX_ENTITIES_PER_BATCH,
        byteLength: compressedSize
    });

    // V18.2.3: Explicitly persist to sharded registry cache
    console.log(`\n💾 [Merge] Updating sharded baseline...`);
    await registryManager.save();

    return { total: exportedCount, sources: sourceStats };
}

mergeBatches().catch(err => {
    console.error(`\n❌ [FATAL] ${err.message}`);
    process.exit(1);
});

export { mergeBatches };
