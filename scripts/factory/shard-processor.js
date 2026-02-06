/**
 * Factory Shard Processor V16.8.7 (CES Compliant)
 * 
 * Constitution: Art 3.1-3.4 (Factory Pipeline)
 * V16.8.7: Uses cache-manager for persistent entity checksums (cross-run diff)
 * 
 * Usage: node scripts/factory/shard-processor.js --shard=N --total=20
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { calculateFNI } from './lib/fni-score.js';
import { hasValidCachePath } from '../l5/entity-validator.js';
import { smartWriteWithVersioning } from './lib/smart-writer.js';
import { loadEntityChecksums, saveEntityChecksums } from './lib/cache-manager.js';
import { normalizeId, getNodeSource } from '../utils/id-normalizer.js';

// Configuration (Art 3.1)
const CONFIG = {
    TOTAL_SHARDS: 20,
    CHECKPOINT_THRESHOLD_HOURS: 5.5,
};

// Parse CLI args
function parseArgs() {
    const args = process.argv.slice(2);
    const shardArg = args.find(a => a.startsWith('--shard='));
    const totalArg = args.find(a => a.startsWith('--total='));
    return {
        shardId: shardArg ? parseInt(shardArg.split('=')[1]) : 0,
        totalShards: totalArg ? parseInt(totalArg.split('=')[1]) : CONFIG.TOTAL_SHARDS,
    };
}

// Atomic entity processing (Art 3.2)
async function processEntity(entity, allEntities, entityChecksums) {
    try {
        const id = normalizeId(entity.id || entity.slug, getNodeSource(entity.id || entity.slug, entity.type), entity.type);

        if (!hasValidCachePath(entity)) {
            console.warn(`[WARN] Skipping ${entity.id || 'unknown'} - Invalid cache path`);
            return { id: id || entity.id, success: false, error: 'Invalid cache path' };
        }

        // Calculate FNI using V2.0 module
        const fniScore = calculateFNI(entity);

        // V16.8.10: Type Normalization & Promotion (Art 3.1)
        const finalType = entity.type || entity.entity_type || 'model';
        const finalFni = fniScore;

        // V14.5.2: Stable _updated - only update if content changed
        const entityHash = crypto.createHash('sha256')
            .update(JSON.stringify({ ...entity, type: finalType }))
            .digest('hex');

        const isChanged = entityChecksums[id] !== entityHash;
        const currentUpdated = entity._updated || new Date().toISOString();

        const enriched = {
            ...entity,
            id: id,
            type: finalType, // Promote to canonical field
            fni_score: finalFni,
            _version: '16.9.7', // Search fix + FNI 2.0
            _updated: isChanged ? new Date().toISOString() : currentUpdated,
            _checksum: entityHash,
        };

        // Smart Write (V2.0 Standard: id is safe for filenames)
        const key = `cache/entities/${finalType}/${id}.json`;
        await smartWriteWithVersioning(key, enriched);


        return {
            id: id,
            slug: enriched.slug,
            name: enriched.name,
            type: enriched.type || 'model',
            source: enriched.source || enriched.source_platform,
            description: enriched.description,
            author: enriched.author,
            downloads: enriched.downloads || enriched.download_count,
            likes: enriched.likes || enriched.like_count,
            fni: finalFni,
            lastModified: enriched._updated,
            success: true,
            _checksum: entityHash, // Pass through for aggregation
        };
    } catch (error) {
        console.error(`[ERROR] ${entity.id}:`, error.message);
        return { id: entity.id, success: false, error: error.message };
    }
}

// ... (skipping loadFniHistory and saveCheckpoint unchanged)

// Main (V14.5.2: with artifact-based checksum tracking)
async function main() {
    const { shardId, totalShards } = parseArgs();
    console.log(`[SHARD ${shardId}/${totalShards}] Starting...`);

    // V16.2.10: Data Safety Guard - 2/4 stage must NEVER write to R2
    // All persistence in 2/4 is via artifacts/cache
    process.env.ENABLE_R2_BACKUP = 'false';

    // V16.2.3: Load manifest for global stats (Avg Velocity)
    let globalStats = 0;
    try {
        const manifest = JSON.parse(await fs.readFile('./data/manifest.json', 'utf-8'));
        globalStats = manifest.stats?.avgVelocity || 0;
        console.log(`[SHARD ${shardId}] Global Avg Velocity: ${globalStats}`);
    } catch (e) {
        console.warn(`[SHARD ${shardId}] Manifest stats not found, using 0 fallback`);
    }

    // V16.2.3: Load sharded input if available (Memory Optimization)
    let entitiesPath = process.env.ENTITIES_PATH || './data/merged.json';
    const shardedPath = `./data/merged_shard_${shardId}.json`;

    try {
        await fs.access(shardedPath);
        entitiesPath = shardedPath;
        console.log(`[SHARD ${shardId}] Using sharded input: ${entitiesPath}`);
    } catch {
        console.log(`[SHARD ${shardId}] Sharded input not found, falling back to: ${entitiesPath}`);
    }

    // V14.5: Load entity checksums for diff detection
    const entityChecksums = await loadEntityChecksums();

    // Load entities for this shard (either sharded file or filtered from merged.json)
    let shardEntities;
    if (entitiesPath === shardedPath) {
        shardEntities = JSON.parse(await fs.readFile(entitiesPath, 'utf-8'));
    } else {
        // If sharded input was not found, filter from the full merged.json
        // This path should ideally not be hit if sharding is properly set up.
        // For FNI calculation, we now use globalStats instead of allEntities.
        const allEntitiesFallback = JSON.parse(await fs.readFile(process.env.ENTITIES_PATH || './data/merged.json', 'utf-8'));
        shardEntities = allEntitiesFallback.filter((_, idx) => idx % totalShards === shardId);
    }
    console.log(`[SHARD ${shardId}] Processing ${shardEntities.length} entities`);

    // Process
    const results = [];
    const startTime = Date.now();
    let skippedCount = 0;

    for (const entity of shardEntities) {
        // Checkpoint check (Art 3.4)
        const elapsedHours = (Date.now() - startTime) / (1000 * 60 * 60);
        if (elapsedHours >= CONFIG.CHECKPOINT_THRESHOLD_HOURS) {
            console.log(`[SHARD ${shardId}] Checkpoint at 5.5h, saving...`);
            await saveCheckpoint(shardId, results, entity.id);
            break;
        }

        // V16.7.1: Normalize ID FIRST (Protocol V1.3 Alignment)
        const normId = normalizeId(entity.id || entity.slug, getNodeSource(entity.id || entity.slug, entity.type), entity.type);

        // Check if entity changed since last run (Hash after normalization)
        const entityHash = crypto.createHash('sha256')
            .update(JSON.stringify({ ...entity, id: normId }))
            .digest('hex');

        if (entityChecksums[normId] === entityHash) {
            skippedCount++;
            results.push({ id: normId, success: true, skipped: true, _checksum: entityHash });
            continue; // Skip unchanged entity
        }

        const result = await processEntity(entity, globalStats, entityChecksums);
        results.push(result);
    }

    // Save shard artifact (Aggregator will merge results and checksums)
    // Save shard artifact (Aggregator will merge results and checksums)
    await fs.mkdir('./artifacts', { recursive: true });
    await fs.writeFile(`./artifacts/shard-${shardId}.json`, JSON.stringify({
        shardId,
        totalShards,
        processedCount: results.length,
        successCount: results.filter(r => r.success).length,
        failureCount: results.filter(r => !r.success).length,
        skippedCount,
        entities: results,
        timestamp: new Date().toISOString(),
    }, null, 2));

    console.log(`[SHARD ${shardId}] Complete. Success: ${results.filter(r => r.success).length}/${results.length}, Skipped: ${skippedCount}`);
}

main().catch(console.error);
