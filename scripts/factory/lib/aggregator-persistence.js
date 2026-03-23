/**
 * Aggregator Persistence V16.11 (CES Compliant)
 * Handles sharded registry saving, mirroring, and artifact consolidation.
 */

import fs from 'fs/promises';
import path from 'path';
import { saveGlobalRegistry, syncCacheState } from './cache-manager.js';

/**
 * Persist the global registry and mirror artifacts for distribution
 */
export async function persistRegistry(rankedEntities, outputDir, cacheDir, rankingsMap, scoreMap) {
    console.log(`[AGGREGATOR] 💾 Persisting sharded registry...`);

    if (!rankedEntities && rankingsMap) {
        // V55.9: High-Fidelity Shard Patching (Binary shards only, no monolith)
        // Monolith streaming removed — createZstdCompressStream buffers ALL data
        // in memory before compressing, causing OOM on 416k+ entities with READMEs.
        // Binary shards (NXVF + AES + Zstd) are the authoritative format.
        const { loadRegistryShardsSequentially } = await import('./registry-loader.js');
        const { saveRegistryShard } = await import('./registry-saver.js');

        let shardsPatched = 0, totalShards = 0;
        await loadRegistryShardsSequentially(async (entities, shardIdx) => {
            totalShards++;
            for (const e of entities) {
                e.fni_percentile = rankingsMap.get(e.id) || 0;
                if (scoreMap && scoreMap.has(e.id)) {
                    const finalFni = scoreMap.get(e.id);
                    e.fni_score = finalFni;
                    e.fni = finalFni;
                }
            }
            await saveRegistryShard(shardIdx, entities);
            shardsPatched++;
            if (global.gc && shardsPatched % 50 === 0) global.gc();
        }, { slim: false });

        if (shardsPatched < totalShards) {
            throw new Error(`[PERSISTENCE] Split-brain: only ${shardsPatched}/${totalShards} shards patched.`);
        }
        console.log(`[AGGREGATOR] ✅ HF Shard Patching Complete (${shardsPatched} shards).`);
    } else {
        // Satellite or Legacy mode: Persistence of provided (usually slim) entities
        await saveGlobalRegistry({
            entities: rankedEntities,
            count: (rankedEntities || []).length,
            lastUpdated: new Date().toISOString()
        });
    }

    // 2. Mirroring (V25.8.2: Binary shards + JSON.gz monolith backup)
    const backupDir = path.join(outputDir, 'meta', 'backup');
    await fs.mkdir(backupDir, { recursive: true });

    const monoliths = ['global-registry.json.zst', 'fni-history.json.zst', 'daily-accum.json.zst', 'entity-checksums.json.zst'];
    for (const file of monoliths) {
        const src = path.join(cacheDir, file);
        try {
            await fs.access(src);
            await fs.copyFile(src, path.join(backupDir, file));
        } catch { }
    }

    const syncDirs = [
        { src: 'registry', dest: 'registry' },
        { src: 'fni-history', dest: 'fni-history' },
        { src: 'daily-accum', dest: 'daily-accum' },
        { src: 'mesh', dest: 'mesh' },
        { src: 'relations', dest: 'relations' },
        { src: 'knowledge', dest: 'knowledge' }
    ];
    for (const dir of syncDirs) {
        const srcPath = path.join(cacheDir, dir.src);
        const destPath = path.join(backupDir, dir.dest);
        try {
            await fs.access(srcPath);
            await fs.mkdir(destPath, { recursive: true });
            const files = await fs.readdir(srcPath);
            for (const f of files) await fs.copyFile(path.join(srcPath, f), path.join(destPath, f));
        } catch { }
    }

    // 3. Reports Assets (V22.8: Daily retired, using reports/ only)
    const reportsSrcDir = path.join(outputDir, 'cache', 'reports');
    const reportsDestDir = path.join(backupDir, 'reports');

    try {
        await fs.mkdir(reportsDestDir, { recursive: true });
        if (await fs.stat(reportsSrcDir).catch(() => null)) {
            const reportFiles = await fs.readdir(reportsSrcDir);
            for (const file of reportFiles) {
                const src = path.join(reportsSrcDir, file);
                const dest = path.join(reportsDestDir, file);
                const stat = await fs.stat(src);
                if (stat.isFile()) await fs.copyFile(src, dest);
                else if (stat.isDirectory()) {
                    await fs.mkdir(path.join(reportsDestDir, file), { recursive: true });
                    const subFiles = await fs.readdir(src);
                    for (const sub of subFiles) await fs.copyFile(path.join(src, sub), path.join(reportsDestDir, file, sub));
                }
            }
        }
    } catch (e) { }

    // 4. Final Cache Sync (V17.6: Avoid EINVAL by skipping redundant sync)
    if (path.resolve(cacheDir) !== path.resolve('./cache')) {
        await syncCacheState(cacheDir, './cache');
    }
}
