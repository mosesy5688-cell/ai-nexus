/**
 * Registry Utils Module
 * handles low-level shard purging and state syncing.
 */
import fs from 'fs/promises';
import path from 'path';

export const SHARD_SIZE = 25000;

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
 */
export async function syncCacheState(sourceDir, targetDir) {
    console.log(`[CACHE] Syncing state: ${sourceDir} → ${targetDir}...`);
    try {
        await fs.mkdir(targetDir, { recursive: true });
        if (fs.cp) {
            await fs.cp(sourceDir, targetDir, { recursive: true, force: true });
        } else {
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
