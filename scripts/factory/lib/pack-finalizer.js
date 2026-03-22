/**
 * V25.8 Pack Finalizer - Shard hash, optimization, and post-pack generation
 * Extracted from pack-db.js to comply with CES Art 5.1 (250-line limit)
 */
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Finalize shard hashes, optimize DBs, and generate V25.8 indexes.
 * @param {Object} metaDbs - Map of meta database handles
 * @param {Object} searchDb - Search database handle
 * @param {Object} ftsDb - FTS5 database handle
 * @param {Object} manifest - Shard manifest object (mutated in place)
 * @param {number} currentShardId - Last shard ID written
 * @param {string} shardDir - Output data directory
 * @param {string} cacheDir - Cache directory
 * @param {Object} stats - Build stats
 * @param {Object} partitionCounts - Partition count map
 * @param {Function} injectMetadata - Metadata injection function
 * @param {Function} printBuildSummary - Summary printer function
 */
export async function finalizePack(metaDbs, searchDb, ftsDb, manifest, currentShardId, shardDir, cacheDir, stats, partitionCounts, injectMetadata, printBuildSummary) {
    // Finalize Shard Hashes
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

    await injectMetadata(metaDbs, searchDb, cacheDir);
    const fullManifest = { shards: manifest, partitions: partitionCounts };
    const manifestJson = JSON.stringify(fullManifest, null, 2);
    const manifestBytes = Buffer.byteLength(manifestJson, 'utf8');
    const MANIFEST_MAX_BYTES = 5 * 1024 * 1024; // V55.9 §Manifest: Pointer-Only < 5MB
    if (manifestBytes > MANIFEST_MAX_BYTES) {
        throw new Error(`[V55.9] Manifest exceeds 5MB limit (${(manifestBytes / 1024 / 1024).toFixed(2)}MB). Strip policy arrays per Pointer-Only doctrine.`);
    }
    await fs.writeFile(path.join(shardDir, 'shards_manifest.json'), manifestJson);
    console.log(`[VFS] Manifest: ${(manifestBytes / 1024).toFixed(1)}KB (limit: 5MB)`);

    printBuildSummary(metaDbs, searchDb, stats, currentShardId);

    // Optimize all databases
    console.log('[VFS] Optimizing databases...');
    Object.values(metaDbs).forEach(db => {
        // V55.9: Per-shard FTS5 removed — no optimize needed
        db.exec("PRAGMA integrity_check; VACUUM;");
        db.close();
    });

    // V55.9 §FTS5 Collapse: Optimize unified FTS5 in search.db
    searchDb.exec("INSERT INTO search(search) VALUES('optimize');");
    searchDb.exec("PRAGMA integrity_check; VACUUM;");
    searchDb.close();

    // V5.8 §1.1: Finalize decoupled FTS5 with incremental merge + WAL checkpoint
    ftsDb.exec("INSERT INTO search(search) VALUES('optimize');");
    ftsDb.pragma('wal_checkpoint(TRUNCATE)'); // Flush WAL to main DB before shipping
    ftsDb.exec("PRAGMA integrity_check; VACUUM;");
    ftsDb.close();
    console.log('[VFS] V55.9: search.db unified (entities + FTS5), fts.db legacy checkpointed.');
}
