#!/usr/bin/env node
/**
 * merge-batches.js
 * 
 * Phase A.3: Merge batch files from parallel harvester jobs
 * Combines all raw_batch_*.json files into merged.json
 * V14.5: Adds Manifest Generation (Integrity V1.1) + Pipeline Summary + Validation
 * 
 * Usage: node scripts/ingestion/merge-batches.js
 */

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { mergeEntities } from './lib/entity-merger.js';
import { loadEntityChecksums, saveEntityChecksums } from '../factory/lib/cache-manager.js';
import { RegistryManager } from '../factory/lib/registry-manager.js';
import { scrubIdentities } from './lib/identity-scrubber.js';
import { finalizeMerge } from './lib/manifest-helper.js';

const DATA_DIR = 'data';
const OUTPUT_FILE = 'data/merged.json.gz';
const MANIFEST_FILE = 'data/manifest.json';
const TOTAL_SHARDS = 20;

// Validation Constants (L1 Logic)
const MAX_BATCH_SIZE_MB = 50;
const MAX_ENTITIES_PER_BATCH = 15000;

function calculateHash(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

async function mergeBatches() {
    console.log('\n🔄 [Merge] Starting batch merge...');
    process.env.ENABLE_R2_BACKUP = 'false';

    const files = await fs.readdir(DATA_DIR);
    const batchFiles = files.filter(f => f.startsWith('raw_batch_') && f.endsWith('.json'));

    if (batchFiles.length === 0) {
        console.log('⚠️ No batch files found in data/');
        return { total: 0, sources: [] };
    }

    const allEntities = [];
    const sourceStats = [];
    const seenIds = new Map();
    const batchManifests = [];

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

            let added = 0;
            let mergedCount = 0;

            for (const entity of entities) {
                if (!entity.id) continue;
                if (seenIds.has(entity.id)) {
                    seenIds.set(entity.id, mergeEntities(seenIds.get(entity.id), entity));
                    mergedCount++;
                } else {
                    if (entity.source_trail && typeof entity.source_trail !== 'string') {
                        entity.source_trail = JSON.stringify(entity.source_trail);
                    }
                    seenIds.set(entity.id, entity);
                    allEntities.push(entity);
                    added++;
                }
            }

            const sourceName = file.replace('raw_batch_', '').replace('.json', '');
            sourceStats.push({ source: sourceName, count: added, file });
            console.log(`   ✓ ${sourceName}: ${added} new | ${mergedCount} augmented`);
        } catch (error) {
            console.error(`   ❌ Error reading ${file}: ${error.message}`);
        }
    }

    const registryManager = new RegistryManager();
    await registryManager.load();
    const registryState = await registryManager.mergeCurrentBatch(allEntities);
    const fullSet = registryState.entities;

    const checksums = await loadEntityChecksums();
    await saveEntityChecksums(checksums);

    // V18.12.5.1: Memory Relief - Clear batch entities from heap
    console.log(`   💡 [Merge] Disposing batch intermediate objects...`);
    seenIds.clear(); // Free references held in the deduplication Map

    if (!registryState.didLoadFromStorage && process.env.GITHUB_ACTIONS) {
        throw new Error(`Registry Load Failure - Emergency Abort to Protect 85k Baseline`);
    }

    if (fullSet.length < 85000) {
        throw new Error(`CRITICAL: Entity count dropped to ${fullSet.length} (Expected >85k).`);
    }

    const dedupedSet = scrubIdentities(fullSet);
    dedupedSet.sort((a, b) => a.id.localeCompare(b.id));

    // V18.12.5.1: Memory Relief - Dispose full registry array before heavy IO
    console.log(`   💡 [Merge] Disposing registry source array...`);
    for (let i = 0; i < allEntities.length; i++) allEntities[i] = null;
    allEntities.length = 0;
    // Note: fullSet is still needed for manifest, but will be nulled at end of function

    // V18.2.3: Streaming Export to bypass V8 string length limit
    const { createWriteStream } = await import('fs');
    const hash = crypto.createHash('sha256');
    let compressedSize = 0;

    await new Promise((resolve, reject) => {
        const output = createWriteStream(OUTPUT_FILE);
        const gzip = zlib.createGzip();
        gzip.pipe(output);

        output.on('error', reject);
        gzip.on('error', reject);
        output.on('finish', resolve);

        // Monitor stream for hash and size
        gzip.on('data', chunk => {
            compressedSize += chunk.length;
            hash.update(chunk);
        });

        // V18.12.5.5: Switch to NDJSON for streaming support (Bypasses 4GB Buffer limit)
        for (let i = 0; i < dedupedSet.length; i++) {
            gzip.write(JSON.stringify(dedupedSet[i]) + '\n');
        }
        gzip.end();
    });

    const mergedHash = hash.digest('hex');

    console.log(`\n✅ [Merge] Complete\n   Total: ${dedupedSet.length} unique entities`);

    await finalizeMerge({
        manifestFile: MANIFEST_FILE,
        outputFile: OUTPUT_FILE,
        mergedContent: null, // No longer using full string
        mergedHash,
        allEntitiesCount: dedupedSet.length,
        batchManifests,
        sourceStats,
        batchFilesCount: batchFiles.length,
        fullSet: dedupedSet,
        MAX_BATCH_SIZE_MB,
        MAX_ENTITIES_PER_BATCH,
        byteLength: compressedSize
    });

    // V18.2.3: Explicitly persist to sharded registry cache
    console.log(`\n💾 [Merge] Updating sharded baseline...`);
    await registryManager.save();

    return { total: dedupedSet.length, sources: sourceStats };
}

mergeBatches().catch(err => {
    console.error(`\n❌ [FATAL] ${err.message}`);
    process.exit(1);
});

export { mergeBatches };
