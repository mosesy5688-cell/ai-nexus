/**
 * Registry Saver Module V18.2.11
 * Handles sharded storage and streaming monolith serialization to bypass V8 limits.
 */
import path from 'path';
import { SHARD_SIZE, purgeStaleShards } from './registry-utils.js';
import { saveWithBackup } from './cache-core.js';

const MONOLITH_FILE = 'global-registry.json.gz';
const REGISTRY_DIR = 'registry';

/**
 * Atomic Shard Saver for Partitioned Aggregation
 * Persists a single shard to disk and R2 using streaming to bypass V8 limits.
 */
export async function saveRegistryShard(index, entities) {
    const timestamp = new Date().toISOString();
    const count = entities.length;
    const shardName = `cache/shards/shard-${index}.json.gz`;
    const outputDir = process.env.OUTPUT_DIR || './output';
    const localPath = path.join(outputDir, shardName);

    console.log(`[CACHE] 💾 Persisting Registry Shard ${index} (${count} entities) to ${shardName}...`);

    const zlib = await import('zlib');
    const { createWriteStream } = await import('fs');
    const { mkdir } = await import('fs/promises');

    await mkdir(path.dirname(localPath), { recursive: true });

    await new Promise((resolve, reject) => {
        const output = createWriteStream(localPath);
        const gzip = zlib.createGzip();
        gzip.pipe(output);

        output.on('error', reject);
        gzip.on('error', reject);
        output.on('finish', resolve);

        gzip.write(`{"entities":[`);
        for (let i = 0; i < count; i++) {
            if (i > 0) gzip.write(',');
            gzip.write(JSON.stringify(entities[i]));
        }
        gzip.write(`],"count":${count},"lastUpdated":"${timestamp}"}`);
        gzip.end();
    });

    // V18.12.5.16: R2 Backup Integration for Streams
    if (process.env.ENABLE_R2_BACKUP === 'true') {
        const { createReadStream } = await import('fs');
        const { createR2Client } = await import('./r2-helpers.js');
        const { PutObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = createR2Client();
        if (s3) {
            try {
                const r2Key = `${process.env.R2_BACKUP_PREFIX || 'meta/backup/'}${shardName}`;
                await s3.send(new PutObjectCommand({
                    Bucket: process.env.R2_BUCKET || 'ai-nexus-assets',
                    Key: r2Key,
                    Body: createReadStream(localPath),
                    ContentType: 'application/x-gzip',
                    ContentEncoding: 'gzip'
                }));
            } catch (err) {
                console.warn(`[CACHE] ⚠️ Shard R2 backup failed: ${err.message}`);
            }
        }
    }
}

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
        const shardName = `cache/shards/shard-${i}.json.gz`;
        await saveWithBackup(shardName, { entities: shardData, count: shardData.length, lastUpdated: timestamp }, { compress: true, outputDir: process.env.OUTPUT_DIR || './output' });
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
