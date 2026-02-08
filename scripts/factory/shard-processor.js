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
import { processEntity } from './lib/processor-core.js';
import { loadEntityChecksums, saveEntityChecksums, loadFniHistory } from './lib/cache-manager.js';
import { normalizeId, getNodeSource } from '../utils/id-normalizer.js';

// Configuration (Art 3.1)
const CONFIG = {
    TOTAL_SHARDS: 20,
    CHECKPOINT_THRESHOLD_HOURS: 5.5,
    CACHE_DIR: process.env.CACHE_DIR || './cache'
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

/**
 * Utility: Save partial results for long-running shards (Art 3.4)
 */
async function saveCheckpoint(shardId, results, lastId) {
    const checkpointPath = `./artifacts/checkpoint-shard-${shardId}.json`;
    await fs.mkdir('./artifacts', { recursive: true });
    await fs.writeFile(checkpointPath, JSON.stringify({
        shardId,
        lastId,
        results,
        timestamp: new Date().toISOString()
    }, null, 2));
}

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

    // V16.12: Load FNI history for 7-day trend embedding
    let fniHistory = {};
    try {
        const historyData = await loadFniHistory();
        fniHistory = historyData.entities || {};
        console.log(`[SHARD ${shardId}] Loaded FNI history for ${Object.keys(fniHistory).length} entities`);
    } catch (e) {
        console.warn(`[SHARD ${shardId}] FNI history load failed, trends will be empty:`, e.message);
    }

    // Load entities for this shard (either sharded file or filtered from merged.json)
    let shardEntities;
    if (entitiesPath === shardedPath) {
        shardEntities = JSON.parse(await fs.readFile(entitiesPath, 'utf-8'));
    } else {
        const allEntitiesFallback = JSON.parse(await fs.readFile(process.env.ENTITIES_PATH || './data/merged.json', 'utf-8'));
        shardEntities = allEntitiesFallback.filter((_, idx) => idx % totalShards === shardId);
    }
    // V16.99: FNI-style Full Processing Guard - Ensure output directories exist
    await fs.mkdir(path.join(CONFIG.CACHE_DIR, 'entities'), { recursive: true });
    await fs.mkdir(path.join(CONFIG.CACHE_DIR, 'html'), { recursive: true });

    // Process
    const results = [];
    const startTime = Date.now();

    for (const entity of shardEntities) {
        // Checkpoint check (Art 3.4)
        const elapsedHours = (Date.now() - startTime) / (1000 * 60 * 60);
        if (elapsedHours >= CONFIG.CHECKPOINT_THRESHOLD_HOURS) {
            console.log(`[SHARD ${shardId}] Checkpoint at 5.5h, saving...`);
            await saveCheckpoint(shardId, results, entity.id);
            break;
        }

        // V16.7.1: Normalize ID FIRST
        const normId = normalizeId(entity.id || entity.slug, getNodeSource(entity.id || entity.slug, entity.type), entity.type);

        // V16.99: Process ALWAYS (FNI-style: no skipping to ensure fragment completeness)
        const result = await processEntity(entity, globalStats, entityChecksums, fniHistory, CONFIG);
        results.push(result);
    }

    // Save shard artifact
    await fs.mkdir('./artifacts', { recursive: true });
    await fs.writeFile(`./artifacts/shard-${shardId}.json`, JSON.stringify({
        shardId,
        totalShards,
        processedCount: results.length,
        successCount: results.filter(r => r.success).length,
        failureCount: results.filter(r => !r.success).length,
        entities: results,
        timestamp: new Date().toISOString(),
    }, null, 2));

    console.log(`[SHARD ${shardId}] Complete. Success: ${results.filter(r => r.success).length}/${results.length}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
