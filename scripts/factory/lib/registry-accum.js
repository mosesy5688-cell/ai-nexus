/**
 * Registry Accumulator Module V16.8.3
 * Extracted from registry-io.js for CES Compliance (Art 5.1)
 */

import fs from 'fs/promises';
import path from 'path';
import { loadWithFallback, saveWithBackup } from './cache-core.js';
import { purgeStaleShards } from './registry-utils.js';

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
        const shards = files.filter(f => f.startsWith('part-') && (f.endsWith('.json.gz') || f.endsWith('.json'))).sort();

        if (shards.length > 0) {
            console.log(`[CACHE] 🧩 Sharded daily accumulator found (${shards.length} parts). Merging...`);
            let allEntries = [];
            let lastUpdated = null;
            let meta = {};

            for (const shard of shards) {
                let data = await fs.readFile(path.join(accumDir, shard));
                const zlib = await import('zlib');
                if (shard.endsWith('.gz') || (data[0] === 0x1f && data[1] === 0x8b)) {
                    data = zlib.gunzipSync(data);
                }
                const parsed = JSON.parse(data.toString('utf-8'));
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

    return loadWithFallback('daily-accum.json.gz', { entries: [], lastUpdated: null });
}

/**
 * Save Daily Accumulator with Sharding Support (V2.0)
 */
export async function saveDailyAccum(accum) {
    const cacheDir = process.env.CACHE_DIR || './cache';
    const entries = accum.entries || [];
    const count = entries.length;
    const timestamp = new Date().toISOString();

    console.log(`[CACHE] Saving ${count} daily entries to shards...`);

    const shardCount = Math.ceil(count / SHARD_SIZE);
    for (let i = 0; i < shardCount; i++) {
        const shardEntries = entries.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE);
        await saveWithBackup(`daily-accum/part-${String(i).padStart(3, '0')}.json.gz`, {
            ...accum,
            entries: shardEntries,
            part: i,
            total: shardCount,
            lastUpdated: timestamp
        }, { compress: true });
    }

    // Monolith fallback for small data
    // V18.2.1: Always save full accum to monolith (Streaming V18.12.5.16)
    const monolithPath = path.join(cacheDir, 'daily-accum.json.gz');
    await new Promise((resolve, reject) => {
        const stream = (async () => {
            const { createWriteStream } = await import('fs');
            const zlib = await import('zlib');
            const output = createWriteStream(monolithPath);
            const gzip = zlib.createGzip();
            gzip.pipe(output);

            output.on('error', reject);
            gzip.on('error', reject);
            output.on('finish', resolve);

            gzip.write(JSON.stringify({ ...accum, entries: [], lastUpdated: timestamp }).replace(']}', ''));
            gzip.write(`,"entries":[`);
            for (let i = 0; i < entries.length; i++) {
                if (i > 0) gzip.write(',');
                gzip.write(JSON.stringify(entries[i]));
            }
            gzip.write(`]}`);
            gzip.end();
        })();
    });

    // Purge stale shards (V18.2.1)
    await purgeStaleShards('daily-accum', shardCount);
}
