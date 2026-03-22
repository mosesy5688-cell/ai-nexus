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
            const content = await fs.readFile(filePath, 'utf-8');
            const stats = await fs.stat(filePath);
            const entities = JSON.parse(content);

            batchManifests.push({
                name: file,
                size: stats.size,
                count: entities.length,
                hash: `sha256:${calculateHash(content)}`
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
            registryState = await registryManager.mergeCurrentBatch(
                entities.filter(e => e.id)
            );

            const sourceName = file.replace('raw_batch_', '').replace('.json', '');
            sourceStats.push({ source: sourceName, count: registryState.added, file });
            console.log(`   ✓ ${sourceName}: ${registryState.added} new | ${registryState.updated} augmented`);

            if (global.gc) global.gc();
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

    // V55.9: Natural sharding export — 1000 entities per shard, 100% Zstd.
    // No monolith. Each shard's Zstd buffer holds ~1000 entities (O(shard) memory).
    console.log(`\n🛡️ [Merge] Exporting via natural sharding (${SHARD_SIZE}/shard, Zstd)...`);
    await zstdCompress(Buffer.from('init'));

    let exportedCount = 0;
    let totalVelocity = 0;
    let compressedSize = 0;
    let shardIndex = 0;
    let shardBuffer = [];
    const hash = crypto.createHash('sha256');

    const flushShard = async () => {
        if (shardBuffer.length === 0) return;
        const json = JSON.stringify(shardBuffer);
        const compressed = await zstdCompress(json);
        const shardFile = path.join(DATA_DIR, `merged_shard_${shardIndex}.json.zst`);
        await fs.writeFile(shardFile, compressed);
        hash.update(compressed);
        compressedSize += compressed.length;
        shardIndex++;
        shardBuffer = [];
    };

    const iterator = registryManager.getStreamingIterator('id ASC');
    for (const entity of iterator) {
        const oldId = entity.id;
        const source = entity.source || getNodeSource(oldId, entity.type);
        const newId = normalizeId(oldId, source, entity.type);
        const scrubbed = { ...entity, id: newId };

        shardBuffer.push(scrubbed);
        totalVelocity += (scrubbed.velocity || 0);
        exportedCount++;

        if (shardBuffer.length >= SHARD_SIZE) {
            await flushShard();
        }

        if (exportedCount % 10000 === 0) {
            console.log(`   - Exported ${exportedCount} entities (${shardIndex} shards)...`);
        }
    }

    // Flush remaining
    await flushShard();

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
