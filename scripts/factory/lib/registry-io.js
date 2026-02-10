/**
 * Registry IO Module V16.7.2 (V2.0 Optimization)
 * Constitution Reference: Art 3.1 (Aggregator), Art 5.1 (Modular)
 * 
 * Handles sharded storage operations for 1M+ entities to prevent OOM
 * and GitHub Cache stability issues.
 */

import fs from 'fs/promises';
import path from 'path';
import { loadWithFallback, saveWithBackup } from './cache-core.js';

const SHARD_SIZE = 25000;
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

        // 2. Try Local Shards
        try {
            const files = await fs.readdir(shardDirPath).catch(() => []);
            const shards = files.filter(f => f.startsWith('part-')).sort();
            if (shards.length > 0) {
                console.log(`[CACHE] 🧩 Local Shards detected (${shards.length} parts). Merging...`);
                let allEntities = [];
                for (const s of shards) {
                    const parsed = await tryLoad(path.join(shardDirPath, s));
                    allEntities = allEntities.concat(parsed.entities || []);
                }
                if (allEntities.length >= REGISTRY_FLOOR) {
                    console.log(`[CACHE] ✅ Local Shards hit: ${allEntities.length} entities.`);
                    return { entities: allEntities, count: allEntities.length, lastUpdated: new Date().toISOString(), didLoadFromStorage: true };
                }
            }
        } catch { }
    }

    // 3. R2 Fallback (Authoritative Monolith)
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

    // 2. Dual-Write Monolith (Gzip Only)
    // V18.2.1: Always save full registry to monolith for recovery visibility
    const monolithData = { entities, count, lastUpdated: timestamp };

    await saveWithBackup(MONOLITH_FILE, monolithData, { compress: true });

    // 3. Purge Stale Shards (V18.2.1 GA)
    await purgeStaleShards(REGISTRY_DIR, shardCount);
}

/**
 * Purge stale sharded files from R2 to prevent baseline mutation
 */
export async function purgeStaleShards(directory, currentShardCount) {
    if (process.env.ENABLE_R2_BACKUP !== 'true') return;

    const { ListObjectsV2Command, DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
    const { createR2Client } = await import('./r2-helpers.js');
    const s3 = createR2Client();
    if (!s3) return;

    const bucket = process.env.R2_BUCKET || 'ai-nexus-assets';
    const prefix = `${process.env.R2_BACKUP_PREFIX || 'meta/backup/'}${directory}/part-`;

    try {
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

/**
 * Sync entire cache directory for GitHub Cache persistence
 * V2.0: Robust directory-level sync
 */
export async function syncCacheState(sourceDir, targetDir) {
    console.log(`[CACHE] Syncing state: ${sourceDir} → ${targetDir}...`);
    try {
        await fs.mkdir(targetDir, { recursive: true });

        // Use recursive copy if available (Node 16.7+)
        if (fs.cp) {
            await fs.cp(sourceDir, targetDir, { recursive: true, force: true });
        } else {
            // Manual recursive copy for older environments if needed
            const entries = await fs.readdir(sourceDir, { withFileTypes: true });
            for (const entry of entries) {
                const src = path.join(sourceDir, entry.name);
                const dest = path.join(targetDir, entry.name);
                if (entry.isDirectory()) {
                    await syncCacheState(src, dest);
                } else {
                    await fs.copyFile(src, dest);
                }
            }
        }
    } catch (e) {
        console.warn(`[CACHE] Sync failed: ${e.message}`);
    }
}

/**
 * Load FNI History with Sharding Support (V2.0)
 */
export async function loadFniHistory() {
    const cacheDir = process.env.CACHE_DIR || './cache';
    const historyDir = path.join(cacheDir, 'fni-history');

    try {
        const files = await fs.readdir(historyDir);
        const shards = files.filter(f => f.startsWith('part-') && (f.endsWith('.json.gz') || f.endsWith('.json'))).sort();

        if (shards.length > 0) {
            console.log(`[CACHE] 🧩 Sharded FNI history found (${shards.length} parts). Merging...`);
            let allEntities = {};
            let lastUpdated = null;
            const zlib = await import('zlib');

            for (const shard of shards) {
                let data = await fs.readFile(path.join(historyDir, shard));
                if (shard.endsWith('.gz') || (data[0] === 0x1f && data[1] === 0x8b)) {
                    data = zlib.gunzipSync(data);
                }
                const parsed = JSON.parse(data.toString('utf-8'));
                Object.assign(allEntities, parsed.entities || {});
                if (!lastUpdated) lastUpdated = parsed.lastUpdated;
            }

            return { entities: allEntities, lastUpdated: lastUpdated || new Date().toISOString() };
        }
    } catch { /* fallback to monolith */ }

    return loadWithFallback('fni-history.json.gz', { entities: {}, lastUpdated: null });
}

/**
 * Save FNI History with Sharding Support (V2.0)
 */
export async function saveFniHistory(history) {
    const entities = history.entities || {};
    const keys = Object.keys(entities);
    const count = keys.length;
    const timestamp = new Date().toISOString();

    console.log(`[CACHE] Saving ${count} history entries to shards...`);

    const shardCount = Math.ceil(count / SHARD_SIZE);
    for (let i = 0; i < shardCount; i++) {
        const shardKeys = keys.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE);
        const shardEntities = {};
        for (const k of shardKeys) shardEntities[k] = entities[k];

        await saveWithBackup(`fni-history/part-${String(i).padStart(3, '0')}.json.gz`, {
            entities: shardEntities,
            part: i,
            total: shardCount,
            lastUpdated: timestamp
        }, { compress: true });
    }

    // Monolith fallback
    // V18.2.1: Always save full history to monolith
    await saveWithBackup('fni-history.json.gz', { ...history, lastUpdated: timestamp }, { compress: true });

    // Purge stale shards (V18.2.1)
    await purgeStaleShards('fni-history', shardCount);
}

export { loadDailyAccum, saveDailyAccum } from './registry-accum.js';
