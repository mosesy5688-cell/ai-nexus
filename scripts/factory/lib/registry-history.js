/**
 * Registry History Module V16.8.6
 * Extracted from registry-io.js for CES Compliance (Art 5.1)
 */

import fs from 'fs/promises';
import path from 'path';
import { SHARD_SIZE, purgeStaleShards } from './registry-utils.js';
import { loadWithFallback, saveWithBackup } from './cache-core.js';
import { autoDecompress } from './zstd-helper.js';

/**
 * Load FNI History with Sharding Support (V55.9: Zstd + legacy gzip compat)
 */
export async function loadFniHistory() {
    const cacheDir = process.env.CACHE_DIR || './cache';
    let historyDir = path.join(cacheDir, 'fni-history');

    let files = [];
    try {
        files = await fs.readdir(historyDir);
    } catch (err) { }
    const shards = files.filter(f => (f.startsWith('part-') || f.startsWith('shard-')) && (f.endsWith('.json.zst') || f.endsWith('.json.gz') || f.endsWith('.json'))).sort();

    if (shards.length > 0) {
        try {
            console.log(`[CACHE] 🧩 Sharded FNI history found (${shards.length} parts). Merging...`);
            let allEntities = {};
            let lastUpdated = null;

            for (const shard of shards) {
                let data = await fs.readFile(path.join(historyDir, shard));
                data = await autoDecompress(data);
                const parsed = JSON.parse(data.toString('utf-8'));
                Object.assign(allEntities, parsed.entities || {});
                if (!lastUpdated) lastUpdated = parsed.lastUpdated;
            }

            return { entities: allEntities, lastUpdated: lastUpdated || new Date().toISOString() };
        } catch (e) {
            console.error(`[CACHE] ❌ Failed to merge history shards: ${e.message}`);
        }
    }

    console.warn('[CACHE] ⚠️ FNI history shards unavailable, falling back to monolithic file');
    return loadWithFallback('fni-history.json.zst', { entities: {}, lastUpdated: null });
}

/**
 * Save FNI History with Sharding Support (V2.0)
 */
export async function saveFniHistory(history) {
    const entities = history.entities || {};
    const keys = Object.keys(entities).sort();
    const count = keys.length;
    const timestamp = new Date().toISOString();

    console.log(`[CACHE] Saving ${count} history entries to shards...`);

    const shardCount = Math.ceil(count / SHARD_SIZE);
    for (let i = 0; i < shardCount; i++) {
        const shardKeys = keys.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE);
        const shardEntities = {};
        for (const k of shardKeys) shardEntities[k] = entities[k];

        await saveWithBackup(`fni-history/part-${String(i).padStart(3, '0')}.json.zst`, {
            entities: shardEntities,
            part: i,
            total: shardCount,
            lastUpdated: timestamp
        }, { compress: true });
    }

    // Monolith fallback
    await saveWithBackup('fni-history.json.zst', { ...history, lastUpdated: timestamp }, { compress: true });

    // Purge stale local shards (prevent backup-dir re-uploading corrupted files)
    const historyDir = path.join(process.env.CACHE_DIR || './cache', 'fni-history');
    try {
        const localFiles = await fs.readdir(historyDir);
        for (const f of localFiles) {
            const m = f.match(/part-(\d+)\./);
            if (m && parseInt(m[1]) >= shardCount) {
                await fs.unlink(path.join(historyDir, f));
            }
        }
    } catch {}

    // Purge stale R2 shards (V18.2.1)
    await purgeStaleShards('fni-history', shardCount);
}
