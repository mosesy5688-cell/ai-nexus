/**
 * Cache Core Module (Static Storage)
 * Final V16.7.2 - CES Compliant
 */
import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import os from 'os';

const getCacheDir = () => process.env.CACHE_DIR || './cache';
const getR2Prefix = () => process.env.R2_BACKUP_PREFIX || 'meta/backup/';
const getR2Bucket = () => process.env.R2_BUCKET || 'ai-nexus-assets';

/**
 * Load data with priority chain
 */
export async function loadWithFallback(filename, defaultValue = {}) {
    const localPath = path.join(getCacheDir(), filename);

    try {
        const data = await fs.readFile(localPath, 'utf-8');
        console.log(`[CACHE] ✅ Loaded from local: ${filename}`);
        return JSON.parse(data);
    } catch {
        console.log(`[CACHE] Local cache miss: ${filename}`);
    }

    const r2Key = `${getR2Prefix()}${filename}`;
    const tempFile = path.join(os.tmpdir(), `r2-${filename.replace(/\//g, '-')}-${Date.now()}.json`);

    try {
        console.log(`[CACHE] R2 Restore: ${filename}...`);
        execSync(
            `npx wrangler r2 object get ${getR2Bucket()}/${r2Key} --file=${tempFile} --remote`,
            { stdio: 'pipe', timeout: 300000 }
        );
        const result = await fs.readFile(tempFile, 'utf-8');
        await fs.mkdir(getCacheDir(), { recursive: true });
        await fs.writeFile(localPath, result);
        await fs.unlink(tempFile).catch(() => { });
        return JSON.parse(result);
    } catch {
        console.log(`[CACHE] ⚠️ R2 Restore Failed/Missing: ${filename}`);
    }

    return defaultValue;
}

/**
 * Save data to local cache and R2 backup
 */
export async function saveWithBackup(filename, data) {
    const localPath = path.join(getCacheDir(), filename);
    const content = JSON.stringify(data, null, 2);

    const dir = path.dirname(localPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(localPath, content);

    if (process.env.ENABLE_R2_BACKUP === 'true') {
        try {
            const r2Key = `${getR2Prefix()}${filename}`;
            const tempFile = path.join(os.tmpdir(), filename.replace(/\//g, '-'));
            await fs.writeFile(tempFile, content);
            execSync(`npx -y wrangler r2 object put ${getR2Bucket()}/${r2Key} --file=${tempFile} --remote`, { stdio: 'pipe' });
            await fs.unlink(tempFile).catch(() => { });
            console.log(`[CACHE] Backed up to R2: ${r2Key}`);
        } catch (err) {
            console.warn(`[CACHE] ⚠️ R2 backup failed: ${err.message}`);
        }
    }
}
