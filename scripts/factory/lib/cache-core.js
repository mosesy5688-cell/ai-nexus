import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import os from 'os';
import crypto from 'crypto';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createR2Client } from './r2-helpers.js';

const getCacheDir = () => process.env.CACHE_DIR || './cache';
const getR2Prefix = () => process.env.R2_BACKUP_PREFIX || 'meta/backup/';
const getR2Bucket = () => process.env.R2_BUCKET || 'ai-nexus-assets';

/**
 * Load data with priority chain
 * V16.8.10: Zero-Trust Hardening (throws on critical failure)
 */
export async function loadWithFallback(filename, defaultValue = {}, isCritical = false) {
    const cacheDir = getCacheDir();
    let localPath = path.join(cacheDir, filename);

    const tryLoad = async (filepath) => {
        let data = await fs.readFile(filepath);
        if (filepath.endsWith('.gz') || (data[0] === 0x1f && data[1] === 0x8b)) {
            const zlib = await import('zlib');
            data = zlib.gunzipSync(data);
        }
        return JSON.parse(data.toString('utf-8'));
    };

    // 1. Try Local (Original or .gz)
    try {
        if (process.env.FORCE_R2_RESTORE !== 'true') {
            try {
                return await tryLoad(localPath);
            } catch {
                if (!filename.endsWith('.gz')) {
                    const gzPath = localPath + '.gz';
                    const result = await tryLoad(gzPath);
                    console.log(`[CACHE] ✅ Loaded from local (.gz): ${filename}.gz`);
                    return result;
                }
                throw new Error('Not found');
            }
        }
    } catch {
        console.log(`[CACHE] Local cache miss: ${filename}`);
    }

    // 2. Try R2 (Original or .gz)
    const tryR2 = async (targetFile, targetKey) => {
        const tempFile = path.join(os.tmpdir(), `r2-${targetFile.replace(/\//g, '-')}-${Date.now()}`);
        console.log(`[CACHE] R2 Restore: ${targetKey}...`);
        execSync(
            `npx wrangler r2 object get ${getR2Bucket()}/${targetKey} --file=${tempFile} --remote`,
            { stdio: 'pipe', timeout: 300000 }
        );
        const result = await tryLoad(tempFile);
        await fs.mkdir(cacheDir, { recursive: true });
        await fs.writeFile(targetFile, await fs.readFile(tempFile));
        await fs.unlink(tempFile).catch(() => { });
        return result;
    };

    try {
        const r2Key = `${getR2Prefix()}${filename}`;
        return await tryR2(localPath, r2Key);
    } catch {
        if (!filename.endsWith('.gz')) {
            try {
                const r2KeyGz = `${getR2Prefix()}${filename}.gz`;
                const localPathGz = localPath + '.gz';
                return await tryR2(localPathGz, r2KeyGz);
            } catch { }
        }
    }

    if (isCritical) {
        throw new Error(`[CRITICAL] Restoration failed for essential file: ${filename}`);
    }
    return defaultValue;
}

/**
 * Save data to local cache and R2 backup
 * V16.8.6: Smart Sync (P0 Cost Fix)
 */
export async function saveWithBackup(filename, data, options = {}) {
    const localPath = path.join(getCacheDir(), filename);
    let content = JSON.stringify(data);

    if (options.compress) {
        const zlib = await import('zlib');
        content = zlib.gzipSync(Buffer.from(content));
    }

    const dir = path.dirname(localPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(localPath, content);

    if (process.env.ENABLE_R2_BACKUP === 'true') {
        const s3 = createR2Client();
        if (!s3) {
            console.warn(`[CACHE] ⚠️ R2 backup skipped: Credentials missing`);
            return;
        }

        try {
            const r2Key = `${getR2Prefix()}${filename}`;
            const localMD5 = crypto.createHash('md5').update(content).digest('hex');

            // 1. Precise Check (Class B Operation: $0.36/1M)
            try {
                const head = await s3.send(new HeadObjectCommand({
                    Bucket: getR2Bucket(),
                    Key: r2Key
                }));
                const remoteHash = head.ETag?.replace(/"/g, '');

                if (localMD5 === remoteHash) {
                    console.log(`[CACHE] ⏭️ Skipped (Unchanged): ${r2Key}`);
                    return; // Saved $4.50 operation fee!
                }
            } catch (e) {
                if (e.name !== 'NotFound' && e.$metadata?.httpStatusCode !== 404) throw e;
            }

            // 2. Upload only if changed (Class A Operation: $4.50/1M)
            console.log(`[CACHE] ⬆️ Backing up (Changed): ${r2Key}`);
            await s3.send(new PutObjectCommand({
                Bucket: getR2Bucket(),
                Key: r2Key,
                Body: content,
                ContentType: options.compress ? 'application/x-gzip' : 'application/json'
            }));
        } catch (err) {
            console.warn(`[CACHE] ⚠️ R2 backup failed: ${err.message}`);
        }
    }
}
