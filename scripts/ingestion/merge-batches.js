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
import { mergeEntities } from './lib/entity-merger.js';
import { loadEntityChecksums, saveEntityChecksums } from '../factory/lib/cache-manager.js';

const DATA_DIR = 'data';
const OUTPUT_FILE = 'data/merged.json';
const MANIFEST_FILE = 'data/manifest.json';

// Validation Constants (L1 Logic)
const MAX_BATCH_SIZE_MB = 50;
const MAX_ENTITIES_PER_BATCH = 15000; // Increased formerged batches

/**
 * Calculate SHA-256 hash of a string
 */
function calculateHash(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Merge all batch files into a single merged.json
 */
async function mergeBatches() {
    console.log('\n🔄 [Merge] Starting batch merge...');

    // Find all batch files
    const files = await fs.readdir(DATA_DIR);
    const batchFiles = files.filter(f => f.startsWith('raw_batch_') && f.endsWith('.json'));

    if (batchFiles.length === 0) {
        console.log('⚠️ No batch files found in data/');
        return { total: 0, sources: [] };
    }

    console.log(`   Found ${batchFiles.length} batch files`);

    const allEntities = [];
    const sourceStats = [];
    const seenIds = new Map(); // Changed from Set to Map for Augmentative Merging
    const batchManifests = [];

    // Process each batch
    for (const file of batchFiles) {
        const filePath = path.join(DATA_DIR, file);
        try {
            const content = await fs.readFile(filePath, 'utf-8');

            // Validation: Size
            const stats = await fs.stat(filePath);
            const sizeMB = stats.size / (1024 * 1024);
            if (sizeMB > MAX_BATCH_SIZE_MB) {
                console.warn(`   ⚠️ [WARN] ${file} exceeds size limit (${sizeMB.toFixed(2)}MB > ${MAX_BATCH_SIZE_MB}MB)`);
            }

            const entities = JSON.parse(content);

            // Validation: Count
            if (entities.length > MAX_ENTITIES_PER_BATCH) {
                console.warn(`   ⚠️ [WARN] ${file} entity count high (${entities.length})`);
            }

            // Calculate Hash
            const fileHash = calculateHash(content);
            batchManifests.push({
                name: file,
                size: stats.size,
                count: entities.length,
                hash: `sha256:${fileHash}`
            });

            // Deduplicate by ID (Layer 1 Dedup) - Augmentative Merging V15.8
            let added = 0;
            let mergedCount = 0;

            for (const entity of entities) {
                if (!entity.id) continue;

                if (seenIds.has(entity.id)) {
                    const existing = seenIds.get(entity.id);
                    const merged = mergeEntities(existing, entity);
                    seenIds.set(entity.id, merged);
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
            console.log(`   ✓ ${sourceName}: ${added} new | ${mergedCount} augmented (${entities.length - added - mergedCount} identical skipped)`);

        } catch (error) {
            console.error(`   ❌ Error reading ${file}: ${error.message}`);
        }
    }

    // V16.2.3: Integrate Global Registry for Sweep Pass (Memory Restoration)
    const registryManager = new RegistryManager();
    await registryManager.load();
    const registryState = await registryManager.mergeCurrentBatch(allEntities);
    const fullSet = registryState.entities;

    // V16.2.7: Sync Checksum Cache (Global Fingerprint Alignment)
    // This prevents 2/4 Shards from thinking 280k archived assets are "new"
    console.log(`\n🔐 [Merge] Syncing global checksum cache for ${fullSet.length} entities...`);
    const checksums = await loadEntityChecksums();
    for (const e of fullSet) {
        if (e._checksum && !checksums[e.id]) {
            checksums[e.id] = e._checksum;
        }
    }
    await saveEntityChecksums(checksums);
    console.log(`   ✓ Checksum cache synchronized`);

    // Integrity Guard: Prevent data wipe if R2 restoration failed (V16.2.3 Emergency Guard)
    // We expect 274k+, so 200k is a safe threshold to detect a serious restoration failure.
    if (fullSet.length < 200000 && process.env.GITHUB_RUN_ID) {
        console.error(`❌ [CRITICAL] Registry restoration failed! Expected ~274k, got ${fullSet.length}.`);
        console.error(`   To prevent data wipe, aborting merge. Check R2 credentials and npx-y wrangler.`);
        throw new Error('Registry Restoration Integrity Failure - Emergency Abort to Protect R2');
    }

    // Write merged output in shards (V16.2.3 Shard-First Implementation)
    const TOTAL_SHARDS = 20;
    console.log(`\n📦 [Merge] Sharding ${fullSet.length} entities into ${TOTAL_SHARDS} processor inputs...`);

    // Sort to ensure stable sharding across runs
    fullSet.sort((a, b) => a.id.localeCompare(b.id));

    for (let s = 0; s < TOTAL_SHARDS; s++) {
        const shardSlice = fullSet.filter((_, idx) => idx % TOTAL_SHARDS === s);
        const shardPath = path.join(DATA_DIR, `merged_shard_${s}.json`);
        await fs.writeFile(shardPath, JSON.stringify(shardSlice, null, 2));
    }

    // Still write a legacy merged.json for any un-migrated scripts (BUT WARN!)
    const mergedContent = JSON.stringify(fullSet, null, 2);
    await fs.writeFile(OUTPUT_FILE, mergedContent);
    const mergedHash = calculateHash(mergedContent);

    console.log(`\n✅ [Merge] Complete`);
    console.log(`   Total: ${fullSet.length} unique entities (Harvested + Registry)`);
    console.log(`   Shards: ${TOTAL_SHARDS} files created in data/`);
    console.log(`   Legacy Output: ${OUTPUT_FILE} (${(Buffer.byteLength(mergedContent) / 1024 / 1024).toFixed(2)} MB)`);

    // Calculate Global Stats for downstream Anomaly Detection (V16.2.3 optimization)
    const avgVelocity = fullSet.reduce((sum, m) => sum + (m.velocity || 0), 0) / (fullSet.length || 1);

    // Generate Integrity Manifest V1.1 (Modified to include Global Stats)
    const manifest = {
        version: 'INTEGRITY-V1.1',
        job_id: process.env.GITHUB_RUN_ID || 'local',
        timestamp: new Date().toISOString(),
        total_entities: allEntities.length,
        stats: {
            avgVelocity: parseFloat(avgVelocity.toFixed(4))
        },
        output: {
            file: 'merged.json',
            hash: `sha256:${mergedHash}`,
            size: Buffer.byteLength(mergedContent)
        },
        batches: batchManifests,
        validation: {
            max_batch_size_mb: MAX_BATCH_SIZE_MB,
            max_entities_per_batch: MAX_ENTITIES_PER_BATCH
        }
    };

    await fs.writeFile(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
    console.log(`   Manifest: ${MANIFEST_FILE}`);

    // Output Pipeline Summary to GITHUB_STEP_SUMMARY
    if (process.env.GITHUB_STEP_SUMMARY) {
        const summary = [
            `## Factory 1/4 - Harvest Complete 🌾`,
            ``,
            `### 📊 Pipeline Stats`,
            `| Metric | Value |`,
            `|--------|-------|`,
            `| **Total Entities** | **${allEntities.length}** |`,
            `| Source Files | ${batchFiles.length} |`,
            `| Total Size | ${(Buffer.byteLength(mergedContent) / 1024 / 1024).toFixed(2)} MB |`,
            ``,
            `### 🛡️ Integrity Check`,
            `- Manifest: \`INTEGRITY-V1.1\``,
            `- Merged Hash: \`${mergedHash.substring(0, 8)}...\``,
            ``,
            `### 📦 Source Breakdown`,
            `| Source | Count |`,
            `|--------|-------|`,
            ...sourceStats.map(s => `| ${s.source} | ${s.count} |`),
            ``
        ].join('\n');

        await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
    }

    return { total: allEntities.length, sources: sourceStats };
}

// Run if called directly
mergeBatches().catch(err => {
    console.error(`\n❌ [FATAL] ${err.message}`);
    process.exit(1);
});

export { mergeBatches };
