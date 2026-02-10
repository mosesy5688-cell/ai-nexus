/**
 * Registry IO Module V16.7.2 (V2.0 Optimization)
 * Constitution Reference: Art 3.1 (Aggregator), Art 5.1 (Modular)
 * 
 * Handles sharded storage operations for 1M+ entities to prevent OOM
 * and GitHub Cache stability issues.
 */

import fs from 'fs/promises';
import path from 'path';
import { SHARD_SIZE, syncCacheState } from './registry-utils.js';
import { loadWithFallback, saveWithBackup } from './cache-core.js';

/**
 * Purge stale sharded files from R2 to prevent baseline mutation
 * V18.2.2: Inlined for CI robustness
 */
export async function purgeStaleShards(directory, currentShardCount) {
    if (process.env.ENABLE_R2_BACKUP !== 'true') return;

    try {
        const { ListObjectsV2Command, DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
        const { createR2Client } = await import('./r2-helpers.js');
        const s3 = createR2Client();
        if (!s3) return;

        const bucket = process.env.R2_BUCKET || 'ai-nexus-assets';
        const prefix = `${process.env.R2_BACKUP_PREFIX || 'meta/backup/'}${directory}/part-`;

        const list = await s3.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix
        }));

        if (!list.Contents) return;

        const deleteBatch = [];
        for (const obj of list.Contents) {
            const match = obj.Key.match(/part-(\d+)\.json(\.gz)?/);
            if (match) {
                const index = parseInt(match[1]);
                if (index >= currentShardCount) {
                    deleteBatch.push({ Key: obj.Key });
                }
            }
        }

        if (deleteBatch.length > 0) {
            console.log(`[CACHE] 🧹 Purging ${deleteBatch.length} stale shards from ${directory}/...`);
            await s3.send(new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: { Objects: deleteBatch }
            }));
        }
    } catch (err) {
        console.warn(`[CACHE] ⚠️ Shard purge failed for ${directory}: ${err.message}`);
    }
}

const REGISTRY_DIR = 'registry';
const MONOLITH_FILE = 'global-registry.json.gz';

/**
 * Load Global Registry with Cache-First Integrity (V18.2.1)
 * Priority: Local Monolith -> Local Shards -> R2 Monolith Backup
 */
export async function loadGlobalRegistry() {
    const cacheDir = process.env.CACHE_DIR || './cache';
    const shardDirPath = path.join(cacheDir, REGISTRY_DIR);
    const monolithPath = path.join(cacheDir, MONOLITH_FILE);
    const REGISTRY_FLOOR = 85000;

    const zlib = await import('zlib');
    const tryLoad = async (filepath) => {
        const data = await fs.readFile(filepath);
        if (filepath.endsWith('.gz') || (data.length > 2 && data[0] === 0x1f && data[1] === 0x8b)) {
            return JSON.parse(zlib.gunzipSync(data).toString('utf-8'));
        }
        return JSON.parse(data.toString('utf-8'));
    };

    // 1. Try Local Monolith (GZ Preferred)
    if (process.env.FORCE_R2_RESTORE !== 'true') {
        try {
            const registry = await tryLoad(monolithPath);
            const count = registry.entities?.length || 0;
            if (count >= REGISTRY_FLOOR) {
                console.log(`[CACHE] ✅ Local Monolith hit: ${count} entities.`);
                return { entities: registry.entities, count, lastUpdated: registry.lastUpdated, didLoadFromStorage: true };
            }
        } catch { }

        // 2. Try Local Shards (Flexible Paths for CI)
        try {
            const shardSearchPaths = [
                shardDirPath,
                path.join(process.cwd(), 'artifacts'),
                path.join(process.cwd(), 'output/cache/shards'),
                path.join(process.cwd(), 'cache/registry'),
                path.join(process.cwd(), 'output/registry'),
                path.join(process.cwd(), 'output/meta/backup/registry')
            ];

            let shardFiles = [];
            let foundPath = null;

            for (const p of shardSearchPaths) {
                const files = await fs.readdir(p).catch(() => []);
                const shards = files.filter(f => f.startsWith('part-') || f.startsWith('shard-') || f.startsWith('merged_shard_')).sort();
                if (shards.length > 0) {
                    shardFiles = shards;
                    foundPath = p;
                    break;
                }
            }

            if (shardFiles.length > 0) {
                console.log(`[CACHE] 🧩 Shards detected in ${foundPath} (${shardFiles.length} parts). Merging...`);
                let allEntities = [];
                for (const s of shardFiles) {
                    const parsed = await tryLoad(path.join(foundPath, s));
                    allEntities = allEntities.concat(parsed.entities || parsed || []);
                }
                if (allEntities.length >= REGISTRY_FLOOR) {
                    console.log(`[CACHE] ✅ Shards hit: ${allEntities.length} entities.`);
                    return { entities: allEntities, count: allEntities.length, lastUpdated: new Date().toISOString(), didLoadFromStorage: true };
                }
            }
        } catch (e) { console.warn(`[CACHE] Shard loading failed: ${e.message}`); }
    }

    // 3. R2 Fallback (Authoritative Monolith)
    if (process.env.ALLOW_R2_RECOVERY === 'true') { // Added check for ALLOW_R2_RECOVERY
        console.log(`[CACHE] 🌐 Local Cache missed or below floor. Attempting R2 Monolith Restoration...`);
        try {
            const registry = await loadWithFallback(MONOLITH_FILE, { entities: [] }, true);
            const count = registry.entities?.length || 0;
            if (count >= REGISTRY_FLOOR) {
                console.log(`[CACHE] ✅ R2 Monolith restored: ${count} entities.`);
                return { entities: registry.entities, count, lastUpdated: registry.lastUpdated, didLoadFromStorage: true };
            }
        } catch (e) {
            console.error(`[CACHE] ❌ R2 Restoration failed: ${e.message}`);
        }
    } else {
        console.warn(`[CACHE] ⚠️ Local baseline not found. R2 recovery disabled for this stage.`);
    }

    console.log('[CACHE] ❌ Integrity Breach: No valid registry found meeting 85k floor.');
    return { entities: [], count: 0, didLoadFromStorage: false };
}

/**
 * Save Global Registry with Dual-Write Support (V2.0 Core)
 */
export async function saveGlobalRegistry(registry) {
    const entities = registry.entities || [];
    const count = entities.length;
    const timestamp = new Date().toISOString();

    console.log(`[CACHE] Saving ${count} entities to sharded registry...`);

    // 1. Save Shards with Gzip (V18.2 Stability)
    const shardCount = Math.ceil(count / SHARD_SIZE);
    for (let i = 0; i < shardCount; i++) {
        const shardEntities = entities.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE);
        const shardData = {
            entities: shardEntities,
            count: shardEntities.length,
            part: i,
            total: shardCount,
            lastUpdated: timestamp
        };
        await saveWithBackup(`${REGISTRY_DIR}/part-${String(i).padStart(3, '0')}.json.gz`, shardData, { compress: true });
    }

    // 2. Dual-Write Monolith (Gzip Only) - DISABLED (V18.2.1: Bypassing RangeError: Invalid string length)
    // const monolithData = { entities, count, lastUpdated: timestamp };
    // await saveWithBackup(MONOLITH_FILE, monolithData, { compress: true });
    console.log(`[CACHE] Monolith save skipped. Sharded registry is now the primary Source of Truth.`);

    // 3. Purge Stale Shards (V18.2.1 GA)
    await purgeStaleShards(REGISTRY_DIR, shardCount);
}


export { loadFniHistory, saveFniHistory } from './registry-history.js';
export { loadDailyAccum, saveDailyAccum } from './registry-accum.js';
export { syncCacheState };
