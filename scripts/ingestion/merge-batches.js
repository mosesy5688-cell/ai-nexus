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

import { promises as fs, createWriteStream } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { mergeEntities } from './lib/entity-merger.js';
import { zstdCompress } from '../factory/lib/zstd-helper.js';
import { loadEntityChecksums, saveEntityChecksums } from '../factory/lib/cache-manager.js';
import { RegistryManager } from '../factory/lib/registry-manager.js';
import { scrubIdentities } from './lib/identity-scrubber.js';
import { finalizeMerge } from './lib/manifest-helper.js';
import { normalizeId, getNodeSource } from '../utils/id-normalizer.js';

const DATA_DIR = 'data';
const OUTPUT_FILE = 'data/merged.json.zst';
const MANIFEST_FILE = 'data/manifest.json';
const TOTAL_SHARDS = 20;

// Validation Constants (L1 Logic)
const MAX_BATCH_SIZE_MB = 50;
const MAX_ENTITIES_PER_BATCH = 15000;

// V55.9: Content truncation limits (Adapter Hardening §2)
const ABSTRACT_LIMIT = 500;
const HEAVY_FIELDS = ['html_readme', 'body_content', 'readme', 'readme_raw', 'readme_html'];

/** V55.9: Strip heavy content fields to prevent OOM in export phase.
 *  Full text lives in enrichment/fulltext/ on R2, not in the registry. */
function truncateHeavyFields(entity) {
    for (const f of HEAVY_FIELDS) {
        if (entity[f] && typeof entity[f] === 'string' && entity[f].length > ABSTRACT_LIMIT) {
            entity[f] = entity[f].substring(0, ABSTRACT_LIMIT);
        }
    }
    if (entity.description && entity.description.length > 1000) {
        entity.description = entity.description.substring(0, 1000);
    }
    return entity;
}

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
    // instead of accumulating all entities in a single heap array (OOM fix).
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

            // V55.9: Truncate heavy fields before SQLite flush (OOM prevention)
            const slim = entities.filter(e => e.id).map(truncateHeavyFields);

            // Flush this batch directly to SQLite (O(B) memory per batch)
            registryState = await registryManager.mergeCurrentBatch(slim);

            const sourceName = file.replace('raw_batch_', '').replace('.json', '');
            sourceStats.push({ source: sourceName, count: registryState.added, file });
            console.log(`   ✓ ${sourceName}: ${registryState.added} new | ${registryState.updated} augmented`);

            // Explicit GC hint between batches
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

    let exportedCount = 0;
    let totalVelocity = 0;
    let compressedSize = 0;
    const hash = crypto.createHash('sha256');

    // V55.9: Chunked Zstd export — write uncompressed to temp, then compress.
    // The Zstd WASM codec buffers all data in memory (no true streaming),
    // so we write uncompressed first (O(1) memory via streaming write),
    // then compress the entire file in a second pass.
    const TEMP_FILE = OUTPUT_FILE + '.tmp';
    await zstdCompress(Buffer.from('init'));

    // Pass 1: Stream entities to uncompressed temp file (O(1) memory)
    await new Promise((resolve, reject) => {
        const output = createWriteStream(TEMP_FILE);
        output.on('error', reject);
        output.on('finish', resolve);

        output.write('[');

        const iterator = registryManager.getStreamingIterator('id ASC');
        for (const entity of iterator) {
            const oldId = entity.id;
            const source = entity.source || getNodeSource(oldId, entity.type);
            const newId = normalizeId(oldId, source, entity.type);

            const scrubbed = { ...entity, id: newId };

            if (exportedCount > 0) output.write(',');
            output.write(JSON.stringify(scrubbed));

            totalVelocity += (scrubbed.velocity || 0);
            exportedCount++;

            if (exportedCount % 10000 === 0) {
                console.log(`   - Streamed ${exportedCount} entities...`);
            }
        }

        output.write(']');
        output.end();
    });

    // Pass 2: Read temp file and compress with Zstd
    console.log(`   💾 [Merge] Compressing ${exportedCount} entities with Zstd...`);
    const { readFileSync, unlinkSync } = await import('fs');
    const raw = readFileSync(TEMP_FILE);
    const compressed = await zstdCompress(raw);
    const { writeFileSync } = await import('fs');
    writeFileSync(OUTPUT_FILE, compressed);
    hash.update(compressed);
    compressedSize = compressed.length;

    try { unlinkSync(TEMP_FILE); } catch {}
    console.log(`   ✅ Compressed: ${(raw.length / 1024 / 1024).toFixed(1)}MB → ${(compressedSize / 1024 / 1024).toFixed(1)}MB`);

    const mergedHash = hash.digest('hex');

    console.log(`\n✅ [Merge] Complete\n   Total: ${exportedCount} unique entities`);

    await finalizeMerge({
        manifestFile: MANIFEST_FILE,
        outputFile: OUTPUT_FILE,
        mergedContent: null,
        mergedHash,
        allEntitiesCount: exportedCount,
        batchManifests,
        sourceStats,
        batchFilesCount: batchFiles.length,
        fullSet: [], // Memory Safety: Pass empty array, velocity handled by aggregate
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
