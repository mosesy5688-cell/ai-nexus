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
export async function persistRegistry(rankedEntities, outputDir, cacheDir) {
    console.log(`[AGGREGATOR] 💾 Persisting sharded registry...`);

    // 1. Sharded Registry
    await saveGlobalRegistry({
        entities: rankedEntities,
        count: rankedEntities.length,
        lastUpdated: new Date().toISOString()
    });

    // 2. Mirroring (V17.5+)
    const backupDir = path.join(outputDir, 'meta', 'backup');
    await fs.mkdir(backupDir, { recursive: true });

    const monoliths = ['global-registry.json.gz', 'fni-history.json.gz', 'daily-accum.json.gz', 'entity-checksums.json.gz'];
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

    // 3. Reports & Daily Assets
    const reportsSrcDir = path.join(outputDir, 'cache', 'reports');
    const reportsDestDir = path.join(backupDir, 'reports');
    const dailySrcDir = path.join(outputDir, 'daily');
    const dailyDestDir = path.join(backupDir, 'daily');

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
        await fs.mkdir(dailyDestDir, { recursive: true });
        if (await fs.stat(dailySrcDir).catch(() => null)) {
            const dailyFiles = await fs.readdir(dailySrcDir);
            for (const file of dailyFiles) await fs.copyFile(path.join(dailySrcDir, file), path.join(dailyDestDir, file));
        }
    } catch (e) { }

    // 4. Final Cache Sync (V17.6: Avoid EINVAL by skipping redundant sync)
    if (path.resolve(cacheDir) !== path.resolve('./cache')) {
        await syncCacheState(cacheDir, './cache');
    }
}
