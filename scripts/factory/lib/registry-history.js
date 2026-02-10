/**
 * Registry History Module V16.8.6
 * Extracted from registry-io.js for CES Compliance (Art 5.1)
 */

import fs from 'fs/promises';
import path from 'path';
import { SHARD_SIZE, purgeStaleShards } from './registry-utils.js';
import { loadWithFallback, saveWithBackup } from './cache-core.js';

/**
 * Load FNI History with Sharding Support (V2.0)
 */
export async function loadFniHistory() {
    const cacheDir = process.env.CACHE_DIR || './cache';
    const historyDir = path.join(cacheDir, 'fni-history');

    try {
        const files = await fs.readdir(historyDir);
        const shards = files.filter(f => (f.startsWith('part-') || f.startsWith('shard-')) && (f.endsWith('.json.gz') || f.endsWith('.json'))).sort();

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
    const keys = Object.keys(entities).sort();
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
    await saveWithBackup('fni-history.json.gz', { ...history, lastUpdated: timestamp }, { compress: true });

    // Purge stale shards (V18.2.1)
    await purgeStaleShards('fni-history', shardCount);
}
