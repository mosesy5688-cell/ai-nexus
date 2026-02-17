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
        const stats = await fs.stat(filepath);
        if (stats.size === 0) throw new Error(`Empty file: ${filepath}`);

        let data = await fs.readFile(filepath);
        // V18.2.3: Gzip Magic Number Sniffing (Reliable detection)
        const isGzip = (data.length > 2 && data[0] === 0x1f && data[1] === 0x8b);

        if (filepath.endsWith('.gz') || isGzip) {
            const zlib = await import('zlib');
            try {
                data = zlib.gunzipSync(data);
            } catch (e) {
                // Defensive: If it failed but wasn't actually a Gzip (sniffing lied or corrupted), 
                // and it ends with .gz, this is a "Fake .gz" situation.
                if (!isGzip) {
                    console.warn(`[CACHE] ⚠️ Fake .gz detected: ${filepath}. Parsing as raw JSON.`);
                } else {
                    throw new Error(`Gzip decompression failed for ${filepath}: ${e.message}`);
                }
            }
        }
        try {
            return JSON.parse(data.toString('utf-8'));
        } catch (e) {
            throw new Error(`JSON parse failed for ${filepath}: ${e.message}`);
        }
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
        console.log(`[CACHE] R2 Restore: ${targetKey}...`);
        const s3 = createR2Client();
        if (!s3) throw new Error('R2 Client unavailable');

        const { GetObjectCommand } = await import('@aws-sdk/client-s3');
        const response = await s3.send(new GetObjectCommand({
            Bucket: getR2Bucket(),
            Key: targetKey
        }));

        const body = await response.Body.transformToByteArray();
        const buffer = Buffer.from(body);

        // Save to local cache for next time
        await fs.mkdir(path.dirname(targetFile), { recursive: true });
        await fs.writeFile(targetFile, buffer);

        // Decompress and parse
        let data = buffer;
        const isGzipHeader = response.ContentEncoding === 'gzip' || targetKey.endsWith('.gz');
        if (isGzipHeader || (data[0] === 0x1f && data[1] === 0x8b)) {
            const zlib = await import('zlib');
            data = zlib.gunzipSync(data);
        }
        return JSON.parse(data.toString('utf-8'));
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

    // V18.2.3: Mandatory Compression Check
    // If filename ends with .gz, we MUST compress to prevent "Fake .gz" artifacts
    const shouldCompress = options.compress || filename.endsWith('.gz');

    if (shouldCompress) {
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
                ContentType: shouldCompress ? 'application/x-gzip' : 'application/json',
                ContentEncoding: shouldCompress ? 'gzip' : undefined
            }));
        } catch (err) {
            console.warn(`[CACHE] ⚠️ R2 backup failed: ${err.message}`);
        }
    }
}
