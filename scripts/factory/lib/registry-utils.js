/**
 * Registry Utils Module
 * handles low-level shard purging and state syncing.
 */
import fs from 'fs/promises';
import path from 'path';

export const SHARD_SIZE = 1000;

/**
 * Shard-file extensions the registry LOADER will actually read back.
 * registry-loader.js loadRegistryShardsSequentially accepts .bin, .json.zst and
 * .json (it rejects .json.gz loudly). A stale file in ANY of these at an index
 * beyond the current shard count is a ghost the loader can pick up, so all of
 * them must be purged -- purging only .bin would leave the hazard half-open.
 */
export const LOADER_VISIBLE_SHARD_EXTS = Object.freeze(['.bin', '.json.zst', '.json', '.json.gz']);

/**
 * Purge stale LOCAL registry shards left by a prior, larger save (PR-GR-C).
 *
 * WHY THIS EXISTS. registry-saver.js saveGlobalRegistry() (the AGGREGATOR path)
 * already purges surplus local shards; registry-manager.js save() (the HARVEST
 * path) did not. When the harvest-side registry shrinks, the surplus high-index
 * shards survive, ride the GHA cache, and are read back by
 * loadRegistryShardsSequentially. Because registry-manager.js load() inserts with
 * INSERT OR IGNORE over shards in sorted filename order, THE FIRST FILE WINS --
 * so a stale ghost can shadow the current record for a whole cycle. That hazard
 * is live independently of any one-time repair; it also produced the duplicate
 * ids that made OP-GR-B self-abandon in run 31563250233.
 *
 * INDEX RULE is aligned verbatim with saveGlobalRegistry's local purge: delete
 * `part-<n>` whose n >= currentShardCount. Best-effort and non-fatal -- a purge
 * failure must never lose a registry that was just written successfully.
 *
 * @param {string} registryDir directory holding part-NNN.* shard files
 * @param {number} currentShardCount number of shards just written
 * @returns {Promise<{purged: number, files: string[]}>}
 */
export async function purgeStaleLocalShards(registryDir, currentShardCount) {
    const files = [];
    try {
        const { readdir, unlink } = await import('fs/promises');
        const localFiles = await readdir(registryDir).catch(() => []);
        for (const f of localFiles) {
            const m = f.match(/^part-(\d+)(\.bin|\.json\.zst|\.json\.gz|\.json)$/);
            if (!m || parseInt(m[1], 10) < currentShardCount) continue;
            await unlink(path.join(registryDir, f)).catch(() => { });
            files.push(f);
        }
        if (files.length > 0) {
            console.log(`[REGISTRY] Purged ${files.length} stale local shard file(s) (index >= ${currentShardCount})`);
        }
    } catch (e) {
        console.warn(`[REGISTRY] Local stale shard purge failed: ${e.message}`);
    }
    return { purged: files.length, files };
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
            // Match all shard formats and purge indices beyond current count.
            const match = obj.Key.match(/part-(\d+)\.(?:json(?:\.(?:gz|zst))?|bin)/);
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
