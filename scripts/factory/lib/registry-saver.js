/**
 * Registry Saver Module V25.8.2
 * Binary VFS 4.1 shards (NXVF + Zstd + AES-CTR) + JSON.gz monolith for SEO/backup.
 */
import path from 'path';
import { SHARD_SIZE, purgeStaleShards } from './registry-utils.js';
import { ShardWriter } from './shard-writer.js';

import { zstdCompress, createZstdCompressStream } from './zstd-helper.js';

const MONOLITH_FILE = 'global-registry.json.zst';

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

    // 2. Monolith Save (Streaming JSON.zst for Backup — V25.9 Zstd)
    await zstdCompress(Buffer.from('init')); // Warm up codec
    const { createWriteStream } = await import('fs');

    await new Promise((resolve, reject) => {
        const output = createWriteStream(monolithPath);
        const zst = createZstdCompressStream();
        zst.pipe(output);

        output.on('error', reject);
        zst.on('error', reject);
        output.on('finish', resolve);

        let i = 0;
        zst.write(`{"entities":[`);
        function writeNext() {
            let ok = true;
            while (i < count && ok) {
                const chunk = (i > 0 ? ',' : '') + JSON.stringify(inputEntities[i]);
                i++;
                ok = zst.write(chunk);
            }
            if (i < count) {
                zst.once('drain', writeNext);
            } else {
                zst.write(`],"count":${count},"lastUpdated":"${timestamp}"}`);
                zst.end();
            }
        }
        writeNext();
    });

    console.log(`[CACHE] Registry persisted. Shards: ${shardCount} (Binary), Monolith: OK (Zstd).`);

    // 3a. Purge stale .bin shards from LOCAL registry dir.
    // Critical: when a run produces fewer shards than a prior run (e.g. entity count
    // drop), prior `part-NNN.bin` files for index >= shardCount are NOT overwritten
    // and persist via GHA cache. Master Fusion's readdir then sweeps them up and
    // silently fuses garbage. See execution memo §18.22.4 for the 80% data-loss
    // incident this prevents.
    try {
        const cacheDir = process.env.CACHE_DIR || './cache';
        const registryDir = path.join(cacheDir, 'registry');
        const { readdir, unlink } = await import('fs/promises');
        const localFiles = await readdir(registryDir).catch(() => []);
        let purged = 0;
        for (const f of localFiles) {
            const m = f.match(/^part-(\d+)\.bin$/);
            if (m && parseInt(m[1]) >= shardCount) {
                await unlink(path.join(registryDir, f)).catch(() => {});
                purged++;
            }
        }
        if (purged > 0) {
            console.log(`[CACHE] 🧹 Purged ${purged} stale local .bin shard(s) (index >= ${shardCount})`);
        }
    } catch (e) {
        console.warn(`[CACHE] ⚠️ Local stale shard purge failed: ${e.message}`);
    }

    // 3b. Purge stale shards from R2
    await purgeStaleShards('registry', shardCount);

    return { count, shardCount, lastUpdated: timestamp };
}
