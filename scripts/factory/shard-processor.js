/**
 * Factory Shard Processor V14.5 (CES Compliant)
 * 
 * Constitution: Art 3.1-3.4 (Factory Pipeline)
 * V14.5: Uses cache-manager for persistent entity checksums (cross-run diff)
 * 
 * Usage: node scripts/factory/shard-processor.js --shard=N --total=20
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { calculateFNI } from '../fni/fni-calc.js';
import { hasValidCachePath } from '../l5/entity-validator.js';
import { smartWriteWithVersioning } from './lib/smart-writer.js';
import { loadEntityChecksums, saveEntityChecksums } from './lib/cache-manager.js';

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
async function processEntity(entity, allEntities) {
    try {
        if (!hasValidCachePath(entity)) {
            return { id: entity.id, success: false, error: 'Invalid cache path' };
        }

        // Calculate FNI using existing module
        const fni = calculateFNI(entity, allEntities);
        const enriched = {
            ...entity,
            fni_score: fni.fni_score,
            fni_p: fni.fni_p,
            fni_v: fni.fni_v,
            fni_c: fni.fni_c,
            fni_u: fni.fni_u,
            _version: '14.4.0',
            _updated: new Date().toISOString(),
            _checksum: crypto.createHash('sha256')
                .update(JSON.stringify(entity))
                .digest('hex'),
        };

        // Smart Write with Versioning (Art 2.2 + Art 2.4)
        // Path: cache/entities/{type}/{source}--{author}--{name}.json
        const slugForPath = (entity.slug || entity.id).replace(/:/g, '--').replace(/\//g, '--');
        const key = `cache/entities/${entity.type || 'model'}/${slugForPath}.json`;
        await smartWriteWithVersioning(key, enriched);

        return {
            id: entity.id,
            slug: entity.slug,
            type: entity.type || 'model',
            fni: fni.fni_score,
            success: true,
        };
    } catch (error) {
        console.error(`[ERROR] ${entity.id}:`, error.message);
        return { id: entity.id, success: false, error: error.message };
    }
}

// Load FNI history from cache
async function loadFniHistory() {
    try {
        const historyPath = process.env.FNI_HISTORY_PATH || './cache/fni-history.json';
        return JSON.parse(await fs.readFile(historyPath, 'utf-8'));
    } catch {
        console.log('[INFO] No FNI history found, starting fresh');
        return {};
    }
}

// Save checkpoint (Art 3.4)
async function saveCheckpoint(shardId, results, lastEntityId) {
    const checkpoint = {
        shardId,
        lastEntityId,
        processedCount: results.length,
        timestamp: new Date().toISOString(),
    };
    await fs.mkdir('./artifacts', { recursive: true });
    await fs.writeFile(
        `./artifacts/checkpoint-shard-${shardId}.json`,
        JSON.stringify(checkpoint, null, 2)
    );
}

// Main (V14.5: with entity checksum tracking)
async function main() {
    const { shardId, totalShards } = parseArgs();
    console.log(`[SHARD ${shardId}/${totalShards}] Starting...`);

    // Load entities
    const entitiesPath = process.env.ENTITIES_PATH || './data/merged.json';
    const allEntities = JSON.parse(await fs.readFile(entitiesPath, 'utf-8'));

    // V14.5: Load entity checksums for diff detection
    const entityChecksums = await loadEntityChecksums();

    // Partition for this shard
    const shardEntities = allEntities.filter((_, idx) => idx % totalShards === shardId);
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

        // V14.5: Check if entity changed since last run
        const entityHash = crypto.createHash('sha256')
            .update(JSON.stringify(entity))
            .digest('hex');

        if (entityChecksums[entity.id] === entityHash) {
            skippedCount++;
            results.push({ id: entity.id, success: true, skipped: true });
            continue; // Skip unchanged entity
        }

        const result = await processEntity(entity, allEntities);
        results.push(result);

        // Update checksum on success
        if (result.success) {
            entityChecksums[entity.id] = entityHash;
        }
    }

    // V14.5: Save updated checksums for next run
    if (shardId === 0) {
        // Only shard 0 saves checksums to avoid race conditions
        await saveEntityChecksums(entityChecksums);
        console.log(`[SHARD ${shardId}] Saved ${Object.keys(entityChecksums).length} entity checksums`);
    }

    // Save shard artifact
    await fs.mkdir('./artifacts', { recursive: true });
    await fs.writeFile(`./artifacts/shard-${shardId}.json`, JSON.stringify({
        shardId,
        totalShards,
        processedCount: results.length,
        successCount: results.filter(r => r.success).length,
        failureCount: results.filter(r => !r.success).length,
        skippedCount, // V14.5: Track skipped unchanged entities
        entities: results,
        timestamp: new Date().toISOString(),
    }, null, 2));

    console.log(`[SHARD ${shardId}] Complete. Success: ${results.filter(r => r.success).length}/${results.length}, Skipped: ${skippedCount}`);
}

main().catch(console.error);
