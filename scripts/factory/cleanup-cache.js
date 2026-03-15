/**
 * GitHub Cache Cleanup Script V16.96.2
 * Purges old sharded registry files to stay under 10GB limit.
 */

import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';

async function cleanupCache() {
    const cacheDir = process.env.CACHE_DIR || './cache';
    const registryDir = path.join(cacheDir, 'registry');
    const fniDir = path.join(cacheDir, 'fni-history');

    console.log('🧹 [CLEANUP] Starting cache maintenance...');

    const dirs = [registryDir, fniDir];
    let deletedCount = 0;
    let deletedSize = 0;

    for (const dir of dirs) {
        try {
            const files = await fs.readdir(dir);
            const now = Date.now();
            const maxAge = 3 * 24 * 60 * 60 * 1000; // 3 days

            for (const file of files) {
                const filePath = path.join(dir, file);
                const stats = await fs.stat(filePath);

                if (now - stats.mtimeMs > maxAge) {
                    await fs.unlink(filePath);
                    deletedCount++;
                    deletedSize += stats.size;
                }
            }
        } catch (e) {
            // Directory might not exist
        }
    }

    if (deletedCount > 0) {
        console.log(`✅ [CLEANUP] Removed ${deletedCount} stale files (~${(deletedSize / 1024 / 1024).toFixed(2)} MB)`);
    } else {
        console.log('⏭️ [CLEANUP] No stale files found. GitHub Cache remains healthy.');
    }

    await cleanupRemoteCache();
}

async function cleanupRemoteCache() {
    try {
        const output = execSync('gh cache list --json id,key,createdAt --limit 100', {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const entries = JSON.parse(output);
        const now = Date.now();
        const maxAge = 3 * 24 * 60 * 60 * 1000; // 3 days
        let remoteDeleted = 0;

        for (const entry of entries) {
            const createdAt = new Date(entry.createdAt).getTime();
            if (now - createdAt > maxAge) {
                execSync(`gh cache delete ${entry.id}`, { stdio: 'pipe' });
                remoteDeleted++;
            }
        }

        if (remoteDeleted > 0) {
            console.log(`✅ [CLEANUP] Purged ${remoteDeleted} remote GHA cache entries.`);
        }
    } catch {
        // gh CLI not available or not authenticated — skip silently
    }
}

cleanupCache().catch(console.error);
