/**
 * V26.5 Pack Finalizer - Shard hash, optimization, and post-pack generation
 * V26.5: search.db eliminated — only metaDbs + ftsDb remain.
 */
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';

export async function finalizePack(metaDbs, ftsDb, manifest, currentShardId, shardDir, cacheDir, stats, partitionCounts, injectMetadata, printBuildSummary) {
    console.log('[VFS] Updating shard hashes...');
    for (let i = 0; i <= currentShardId; i++) {
        const name = `fused-shard-${String(i).padStart(3, '0')}.bin`;
        const file = path.join(shardDir, name);
        if (fsSync.existsSync(file)) {
            const hash = crypto.createHash('sha256').update(fsSync.readFileSync(file)).digest('hex');
            manifest[`data/${name}`] = hash;
            Object.values(metaDbs).forEach(db => {
                db.prepare('UPDATE entities SET shard_hash = ? WHERE bundle_key = ?').run(hash, `data/${name}`);
            });
        }
    }

    await injectMetadata(metaDbs, null, cacheDir);
    const fullManifest = { shards: manifest, partitions: partitionCounts };
    const manifestJson = JSON.stringify(fullManifest, null, 2);
    const manifestBytes = Buffer.byteLength(manifestJson, 'utf8');
    if (manifestBytes > 5 * 1024 * 1024) {
        throw new Error(`[V55.9] Manifest exceeds 5MB limit (${(manifestBytes / 1024 / 1024).toFixed(2)}MB).`);
    }
    await fs.writeFile(path.join(shardDir, 'shards_manifest.json'), manifestJson);
    console.log(`[VFS] Manifest: ${(manifestBytes / 1024).toFixed(1)}KB (limit: 5MB)`);

    console.log('[VFS] Optimizing databases before size check...');
    Object.values(metaDbs).forEach(db => db.exec("PRAGMA integrity_check; VACUUM;"));

    printBuildSummary(metaDbs, null, stats, currentShardId);
    // metaDbs NOT closed here — pack-db Phase 6 reads from them after finalize

    ftsDb.exec("INSERT INTO search(search) VALUES('optimize');");
    ftsDb.pragma('wal_checkpoint(TRUNCATE)');
    ftsDb.exec("PRAGMA integrity_check; VACUUM;");
    ftsDb.close();
    console.log('[VFS] V26.5: search.db eliminated. fts.db checkpointed.');
}
