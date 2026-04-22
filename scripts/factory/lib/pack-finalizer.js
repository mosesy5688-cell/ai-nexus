/**
 * V26.5 Pack Finalizer - Shard hash, optimization, and post-pack generation
 * V26.5: search.db eliminated — only metaDbs + ftsDb remain.
 */
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';

export async function finalizePack(metaDbs, ftsDb, manifest, currentShardId, shardDir, cacheDir, stats, partitionCounts, injectMetadata, printBuildSummary) {
    console.log('[VFS] Computing shard manifest hashes...');
    const hashStart = Date.now();
    for (let i = 0; i <= currentShardId; i++) {
        const name = `fused-shard-${String(i).padStart(3, '0')}.bin`;
        const file = path.join(shardDir, name);
        if (fsSync.existsSync(file)) {
            manifest[`data/${name}`] = crypto.createHash('sha256').update(fsSync.readFileSync(file)).digest('hex');
        }
    }
    console.log(`[VFS] Manifest hashes computed (${((Date.now() - hashStart) / 1000).toFixed(1)}s)`);

    await injectMetadata(metaDbs, null, cacheDir);
    const fullManifest = { shards: manifest, partitions: partitionCounts };
    const manifestJson = JSON.stringify(fullManifest, null, 2);
    const manifestBytes = Buffer.byteLength(manifestJson, 'utf8');
    if (manifestBytes > 5 * 1024 * 1024) {
        throw new Error(`[V55.9] Manifest exceeds 5MB limit (${(manifestBytes / 1024 / 1024).toFixed(2)}MB).`);
    }
    await fs.writeFile(path.join(shardDir, 'shards_manifest.json'), manifestJson);
    console.log(`[VFS] Manifest: ${(manifestBytes / 1024).toFixed(1)}KB (limit: 5MB)`);

    console.log('[VFS] Optimizing databases...');
    const vacStart = Date.now();
    Object.values(metaDbs).forEach(db => db.exec("VACUUM;"));
    console.log(`[VFS] VACUUM ${Object.keys(metaDbs).length} meta DBs (${((Date.now() - vacStart) / 1000).toFixed(1)}s)`);

    printBuildSummary(metaDbs, null, stats, currentShardId);

    ftsDb.exec("INSERT INTO search(search) VALUES('optimize');");
    ftsDb.pragma('wal_checkpoint(TRUNCATE)');
    ftsDb.exec("VACUUM;");
    ftsDb.close();
    console.log('[VFS] fts.db optimized.');
}
