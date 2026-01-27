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
            let merged = 0;

            for (const entity of entities) {
                if (!entity.id) continue;

                if (seenIds.has(entity.id)) {
                    const existing = seenIds.get(entity.id);

                    // 1. Content Priority (Readme)
                    if ((entity.body_content?.length || 0) > (existing.body_content?.length || 0)) {
                        existing.body_content = entity.body_content;
                        existing.description = entity.description || existing.description;
                    }

                    // 2. Metadata Augmentation (Deep Merge meta_json)
                    try {
                        const existingMeta = typeof existing.meta_json === 'string' ? JSON.parse(existing.meta_json) : (existing.meta_json || {});
                        const newMeta = typeof entity.meta_json === 'string' ? JSON.parse(entity.meta_json) : (entity.meta_json || {});

                        // Deep merge: newMeta values win if they are not null/undefined
                        const mergedMeta = { ...existingMeta };
                        for (const [key, value] of Object.entries(newMeta)) {
                            if (value !== null && value !== undefined) {
                                if (typeof value === 'object' && !Array.isArray(value) && existingMeta[key]) {
                                    mergedMeta[key] = { ...existingMeta[key], ...value };
                                } else {
                                    mergedMeta[key] = value;
                                }
                            }
                        }
                        existing.meta_json = JSON.stringify(mergedMeta);

                        // 3. Technical Spec Prioritization (Force update if null)
                        const techFields = ['params_billions', 'architecture', 'context_length', 'hidden_size', 'num_layers'];
                        for (const field of techFields) {
                            if (!existing[field] && entity[field]) {
                                existing[field] = entity[field];
                            }
                        }
                    } catch (e) {
                        // Fallback if parsing fails
                    }

                    // 4. Tags & Metrics
                    const tagSet = new Set([...(existing.tags || []), ...(entity.tags || [])]);
                    existing.tags = Array.from(tagSet);

                    existing.likes = Math.max(existing.likes || 0, entity.likes || 0);
                    existing.downloads = Math.max(existing.downloads || 0, entity.downloads || 0);

                    // 5. Source Trail Merging
                    try {
                        const existingTrail = typeof existing.source_trail === 'string' ? JSON.parse(existing.source_trail) : (existing.source_trail || []);
                        const newTrail = typeof entity.source_trail === 'string' ? JSON.parse(entity.source_trail) : (entity.source_trail || []);
                        existing.source_trail = JSON.stringify([...existingTrail, ...newTrail]);
                    } catch (e) {
                        // Fallback
                    }

                    merged++;
                } else {
                    // Normalize trail to string for consistent storage if it's an object
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
            console.log(`   ✓ ${sourceName}: ${added} new | ${merged} augmented (${entities.length - added - merged} identical skipped)`);

        } catch (error) {
            console.error(`   ❌ Error reading ${file}: ${error.message}`);
        }
    }

    // Write merged output
    const mergedContent = JSON.stringify(allEntities, null, 2);
    await fs.writeFile(OUTPUT_FILE, mergedContent);
    const mergedHash = calculateHash(mergedContent);

    console.log(`\n✅ [Merge] Complete`);
    console.log(`   Total: ${allEntities.length} unique entities`);
    console.log(`   Sources: ${sourceStats.length}`);
    console.log(`   Output: ${OUTPUT_FILE}`);

    // Generate Integrity Manifest V1.1
    const manifest = {
        version: 'INTEGRITY-V1.1',
        job_id: process.env.GITHUB_RUN_ID || 'local',
        timestamp: new Date().toISOString(),
        total_entities: allEntities.length,
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
mergeBatches().catch(console.error);

export { mergeBatches };
