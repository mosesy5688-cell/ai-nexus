/**
 * Registry Accumulator Module V16.8.3
 * Extracted from registry-io.js for CES Compliance (Art 5.1)
 */

import fs from 'fs/promises';
import path from 'path';
import { loadWithFallback, saveWithBackup } from './cache-core.js';

const SHARD_SIZE = 25000;
const REGISTRY_DIR = 'registry';

/**
 * Load Daily Accumulator with Sharding Support (V2.0)
 */
export async function loadDailyAccum() {
    const cacheDir = process.env.CACHE_DIR || './cache';
    const accumDir = path.join(cacheDir, 'daily-accum');

    try {
        const files = await fs.readdir(accumDir);
        const shards = files.filter(f => f.startsWith('part-') && f.endsWith('.json')).sort();

        if (shards.length > 0) {
            console.log(`[CACHE] 🧩 Sharded daily accumulator found (${shards.length} parts). Merging...`);
            let allEntries = [];
            let lastUpdated = null;
            let meta = {};

            for (const shard of shards) {
                const data = await fs.readFile(path.join(accumDir, shard), 'utf-8');
                const parsed = JSON.parse(data);
                allEntries = allEntries.concat(parsed.entries || []);
                if (!lastUpdated) {
                    lastUpdated = parsed.lastUpdated;
                    meta = { ...parsed };
                    delete meta.entries;
                }
            }

            return { ...meta, entries: allEntries, lastUpdated: lastUpdated || new Date().toISOString() };
        }
    } catch { /* fallback to monolith */ }

    return loadWithFallback('daily-accum.json', { entries: [], lastUpdated: null });
}

/**
 * Save Daily Accumulator with Sharding Support (V2.0)
 */
export async function saveDailyAccum(accum) {
    const entries = accum.entries || [];
    const count = entries.length;
    const timestamp = new Date().toISOString();

    console.log(`[CACHE] Saving ${count} daily entries to shards...`);

    const shardCount = Math.ceil(count / SHARD_SIZE);
    for (let i = 0; i < shardCount; i++) {
        const shardEntries = entries.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE);
        await saveWithBackup(`daily-accum/part-${String(i).padStart(3, '0')}.json`, {
            ...accum,
            entries: shardEntries,
            part: i,
            total: shardCount,
            lastUpdated: timestamp
        });
    }

    // Monolith fallback for small data
    if (count < 50000) {
        await saveWithBackup('daily-accum.json', { ...accum, lastUpdated: timestamp });
    }
}
