/**
 * V26.5 Pack Finalizer - Shard hash, optimization, and post-pack generation
 * V26.5: search.db eliminated.
 * V27.104: fts.db eliminated (no live reader) — only metaDbs remain.
 */
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';

export async function finalizePack(metaDbs, manifest, currentShardId, shardDir, cacheDir, stats, partitionCounts, injectMetadata, printBuildSummary) {
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
    try { if (fsSync.readdirSync(shardDir).some(f => f.startsWith('rankings-') && f.endsWith('.db'))) partitionCounts.rankings_dbs = true; } catch {};
    // V27.26: total_entities = authoritative global catalog size, derived from
    // stats.packed (count of entities written across all meta DBs). Surfaces
    // can read this via manifest.partitions.total_entities to render an honest
    // live count instead of fabricated marketing numbers.
    if (stats && typeof stats.packed === 'number' && stats.packed > 0) {
        partitionCounts.total_entities = stats.packed;
    }

    // V27.49: type-count sanity warning — surface entity-type underrepresentation
    // in cron logs. Catches harvester/adapter regressions early (e.g., dataset
    // adapter throwing silently, prompt adapter not yet built, space adapter
    // mis-typing). Threshold 0.1% (vs the planned 1%) tuned to catch real
    // catalog-wide gaps without false-firing on naturally-rare types.
    try {
        const typeCounts = {};
        for (const db of Object.values(metaDbs)) {
            for (const row of db.prepare('SELECT type, COUNT(*) AS n FROM entities GROUP BY type').iterate()) {
                typeCounts[row.type || '?'] = (typeCounts[row.type || '?'] || 0) + row.n;
            }
        }
        const total = Object.values(typeCounts).reduce((a, b) => a + b, 0);
        partitionCounts.type_counts = typeCounts;
        if (total > 0) {
            for (const [t, n] of Object.entries(typeCounts)) {
                const pct = (n / total) * 100;
                const tag = pct < 0.1 ? '⚠️ UNDER-REPRESENTED' : 'ok';
                console.log(`[VFS-TYPES] ${t}: ${n} (${pct.toFixed(2)}%) ${tag}`);
            }
            // Expected types — warn if completely absent (count=0). Knowledge entities
            // are surface routes (30 static .md), not packed in meta-NN.db — exclude.
            // 'prompt' removed — entity type cancelled, dropped at pack source.
            const expectedTypes = ['model', 'paper', 'tool', 'dataset', 'agent', 'space'];
            const missing = expectedTypes.filter(t => !typeCounts[t]);
            if (missing.length > 0) {
                console.warn(`[VFS-TYPES] ⚠️ Expected types absent from catalog: ${missing.join(', ')}`);
            }
        }
    } catch (e) {
        console.warn(`[VFS-TYPES] Sanity check skipped: ${e.message}`);
    }

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
}
