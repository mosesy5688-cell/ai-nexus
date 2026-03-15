/**
 * Registry Saver Module V25.8.2
 * Binary VFS 4.1 shards (NXVF + Zstd + AES-CTR) + JSON.gz monolith for SEO/backup.
 */
import path from 'path';
import { SHARD_SIZE, purgeStaleShards } from './registry-utils.js';
import { ShardWriter } from './shard-writer.js';

const MONOLITH_FILE = 'global-registry.json.gz';

/**
 * Save a registry shard as Binary VFS 4.1 (.bin)
 * Replaces legacy JSON.gz shards with NXVF binary format.
 */
export async function saveRegistryShard(index, entities) {
    const count = entities.length;
    const cacheDir = process.env.CACHE_DIR || './cache';
    const registryDir = path.join(cacheDir, 'registry');
    const { mkdir } = await import('fs/promises');
    await mkdir(registryDir, { recursive: true });

    console.log(`[CACHE] Persisting Registry Shard ${index} (${count} entities) [Binary V4.1]`);

    const writer = new ShardWriter(registryDir, 'part');
    await writer.init();
    writer.shardId = index;
    writer.open();

    for (const entity of entities) {
        const payload = Buffer.from(JSON.stringify(entity));
        writer.writeEntity(payload);
    }
    writer.finalize();

    // V25.8.3: Purge legacy .json.gz ghost files (replaced by binary .bin)
    // Old pipeline wrote .json.gz; these persist through GHA cache and cause
    // Rust stream-aggregator to read stale/corrupted data instead of current .bin.
    const { unlink } = await import('fs/promises');
    const legacyGz = path.join(registryDir, `part-${String(index).padStart(3, '0')}.json.gz`);
    const legacyJson = path.join(registryDir, `part-${String(index).padStart(3, '0')}.json`);
    await unlink(legacyGz).catch(() => {});
    await unlink(legacyJson).catch(() => {});

    // R2 backup for binary shards
    const shardFile = `part-${String(index).padStart(3, '0')}.bin`;
    if (process.env.ENABLE_R2_BACKUP === 'true') {
        const { createReadStream } = await import('fs');
        const { createR2Client } = await import('./r2-helpers.js');
        const { PutObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = createR2Client();
        if (s3) {
            try {
                const r2Key = `${process.env.R2_BACKUP_PREFIX || 'meta/backup/'}registry/${shardFile}`;
                await s3.send(new PutObjectCommand({
                    Bucket: process.env.R2_BUCKET || 'ai-nexus-assets',
                    Key: r2Key,
                    Body: createReadStream(path.join(registryDir, shardFile)),
                    ContentType: 'application/octet-stream'
                }));
            } catch (err) {
                console.warn(`[CACHE] Shard R2 backup failed: ${err.message}`);
            }
        }
    }
}

/**
 * Save global registry: Binary shards + JSON.gz monolith (SEO/Backup).
 * Monolith remains JSON.gz for CDN/SEO compatibility.
 */
export async function saveGlobalRegistry(input) {
    const inputEntities = Array.isArray(input) ? input : (input?.entities || []);
    const count = inputEntities.length;
    const timestamp = new Date().toISOString();

    console.log(`[CACHE] Persisting Registry (${count} entities)...`);

    const cacheDir = process.env.CACHE_DIR || './cache';
    const monolithPath = path.join(cacheDir, MONOLITH_FILE);

    // 1. Binary Sharded Save (V25.8.2 NXVF)
    const shardCount = Math.ceil(count / SHARD_SIZE);
    for (let i = 0; i < shardCount; i++) {
        const shardData = inputEntities.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE);
        await saveRegistryShard(i, shardData);
    }

    // 2. Monolith Save (Streaming JSON.gz for SEO/Backup — NOT binary)
    const zlib = await import('zlib');
    const { createWriteStream } = await import('fs');

    await new Promise((resolve, reject) => {
        const output = createWriteStream(monolithPath);
        const gzip = zlib.createGzip();
        gzip.pipe(output);

        output.on('error', reject);
        gzip.on('error', reject);
        output.on('finish', resolve);

        // V25.8.3: Async write with backpressure handling to prevent data truncation.
        // Old sync loop (gzip.write in tight for-loop) could overflow the internal
        // buffer, causing truncated \uXXXX escapes in the output JSON.
        let i = 0;
        gzip.write(`{"entities":[`);
        function writeNext() {
            let ok = true;
            while (i < count && ok) {
                const chunk = (i > 0 ? ',' : '') + JSON.stringify(inputEntities[i]);
                i++;
                ok = gzip.write(chunk);
            }
            if (i < count) {
                gzip.once('drain', writeNext);
            } else {
                gzip.write(`],"count":${count},"lastUpdated":"${timestamp}"}`);
                gzip.end();
            }
        }
        writeNext();
    });

    console.log(`[CACHE] Registry persisted. Shards: ${shardCount} (Binary), Monolith: OK (JSON.gz).`);

    // 3. Purge stale shards from R2
    await purgeStaleShards('registry', shardCount);

    return { count, shardCount, lastUpdated: timestamp };
}
