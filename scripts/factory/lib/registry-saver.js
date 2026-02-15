/**
 * Registry Saver Module V18.2.11
 * Handles sharded storage and streaming monolith serialization to bypass V8 limits.
 */
import path from 'path';
import { SHARD_SIZE, purgeStaleShards } from './registry-utils.js';
import { saveWithBackup } from './cache-core.js';

const MONOLITH_FILE = 'global-registry.json.gz';
const REGISTRY_DIR = 'registry';

export async function saveGlobalRegistry(input) {
    const inputEntities = Array.isArray(input) ? input : (input?.entities || []);
    const count = inputEntities.length;
    const timestamp = new Date().toISOString();

    console.log(`[CACHE] 💾 Persisting Registry (${count} entities)...`);

    const cacheDir = process.env.CACHE_DIR || './cache';
    const shardDirPath = path.join(cacheDir, REGISTRY_DIR);
    const monolithPath = path.join(cacheDir, MONOLITH_FILE);

    // 1. Sharded Save (Atomic Chunks)
    const shardCount = Math.ceil(count / SHARD_SIZE);
    const fs = await import('fs/promises');
    await fs.mkdir(shardDirPath, { recursive: true });

    for (let i = 0; i < shardCount; i++) {
        const shardData = inputEntities.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE);
        const shardName = `registry/part-${String(i).padStart(3, '0')}.json.gz`;
        await saveWithBackup(shardName, { entities: shardData, count: shardData.length, lastUpdated: timestamp }, { compress: true });
    }

    // 2. Monolith Save (Streaming to bypass V8 limits)
    const zlib = await import('zlib');
    const { createWriteStream } = await import('fs');

    await new Promise((resolve, reject) => {
        const output = createWriteStream(monolithPath);
        const gzip = zlib.createGzip();
        gzip.pipe(output);

        output.on('error', reject);
        gzip.on('error', reject);
        output.on('finish', resolve);

        gzip.write(`{"entities":[`);
        for (let i = 0; i < count; i++) {
            if (i > 0) gzip.write(',');
            gzip.write(JSON.stringify(inputEntities[i]));
        }
        gzip.write(`],"count":${count},"lastUpdated":"${timestamp}"}`);
        gzip.end();
    });

    console.log(`[CACHE] ✅ Registry persisted. Shards: ${shardCount}, Monolith: OK (Via Stream).`);

    // 3. Purge stale shards from R2
    await purgeStaleShards('registry', shardCount);

    return { count, shardCount, lastUpdated: timestamp };
}
