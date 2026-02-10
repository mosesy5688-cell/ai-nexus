import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';
import { PutObjectCommand, ListObjectsV2Command, S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { rotateEntityVersions } from './entity-versioner.js';

/**
 * Shared R2 Client Creator
 */
export function createR2Client() {
    const config = {
        accountId: process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID,
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    };

    if (!config.accountId || !config.accessKeyId || !config.secretAccessKey) {
        return null;
    }

    return new S3Client({
        region: 'auto',
        endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey
        }
    });
}

/**
 * Surgical fetch - only list objects matching the allowed prefixes
 */
export async function fetchAllR2ETags(s3, bucket, prefixFilter = []) {
    if (prefixFilter.length > 0) {
        console.log(`📥 Fetching R2 ETags (Surgical: ${prefixFilter.join(', ')})...`);
    } else {
        console.log('📥 Fetching R2 ETags (Full Batch)...');
    }

    const startTime = Date.now();
    const etagMap = new Map();
    const prefixes = prefixFilter.length > 0 ? prefixFilter : [undefined];

    for (const prefix of prefixes) {
        let continuationToken = undefined;
        let pCount = 0;

        do {
            const response = await s3.send(new ListObjectsV2Command({
                Bucket: bucket,
                MaxKeys: 1000,
                Prefix: prefix,
                ContinuationToken: continuationToken
            }));

            for (const obj of response.Contents || []) {
                etagMap.set(obj.Key, obj.ETag?.replace(/"/g, ''));
            }

            pCount++;
            continuationToken = response.NextContinuationToken;
            if (prefix) {
                process.stdout.write(`\r   [${prefix}] Pages: ${pCount}, Total Objects: ${etagMap.size}`);
            } else {
                process.stdout.write(`\r   Pages: ${pCount}, Objects: ${etagMap.size}`);
            }
        } while (continuationToken);
    }

    console.log(`\n   ✅ Loaded ${etagMap.size} ETags in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    return etagMap;
}

/**
 * Reliable upload with retries (V16.11: Production Gzip Support)
 */
export async function uploadFile(s3, bucket, localPath, remotePath, remoteETag, retryCount = 0) {
    const MAX_RETRIES = 3;
    try {
        const content = await fs.readFile(localPath);

        // V16.11: Detect pre-compressed Gzip content (Magic number 1f 8b)
        let contentEncoding = undefined;
        if (content[0] === 0x1f && content[1] === 0x8b) {
            contentEncoding = 'gzip';
        }

        const localMD5 = crypto.createHash('md5').update(content).digest('hex');

        if (localMD5 === remoteETag) {
            // console.log(`  [SKIP] Unchanged: ${remotePath}`);
            return { success: true, path: remotePath, skipped: true };
        }

        const mimeMap = {
            '.json': 'application/json',
            '.gz': 'application/gzip',
            '.webp': 'image/webp',
            '.svg': 'image/svg+xml',
            '.txt': 'text/plain',
            '.html': 'text/html',
            '.xml': 'application/xml',
        };

        const ext = path.extname(remotePath).toLowerCase();
        const contentType = mimeMap[ext] || 'application/octet-stream';

        if (remotePath.includes('cache/') || remotePath.includes('entities/')) {
            await rotateEntityVersions(s3, bucket, remotePath).catch(() => { });
        }

        await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: remotePath,
            Body: content,
            ContentType: contentType,
            ContentEncoding: contentEncoding
        }));

        return { success: true, path: remotePath, skipped: false };
    } catch (e) {
        if (retryCount < MAX_RETRIES) {
            const backoff = 1000 * Math.pow(2, retryCount);
            await new Promise(r => setTimeout(r, backoff));
            return uploadFile(s3, bucket, localPath, remotePath, remoteETag, retryCount + 1);
        }
        return { success: false, path: remotePath, error: e.message };
    }
}

/**
 * Purge of Entropy: Delete uncompressed files that have Gzip equivalents
 * V18.2.1: Expanded to include .xml and explicit legacy monoliths
 */
export async function purgeEntropy(s3, bucket, etagMap) {
    console.log('\n🧹 Starting Purge of Entropy (Deep Scrub)...');
    let purged = 0;
    const deleteBatch = [];

    const { DeleteObjectsCommand } = await import('@aws-sdk/client-s3');

    // Explicit Legacy Blacklist: These should NEVER exist in production anymore
    const BLACKLIST = [
        'cache/search-full.json',
        'cache/search-full.json.gz',
        'cache/search-core.json'
    ];

    for (const legacyKey of BLACKLIST) {
        if (etagMap.has(legacyKey)) {
            deleteBatch.push({ Key: legacyKey });
            purged++;
        }
    }

    // Dynamic Purge: any .json that has a .gz equivalent
    for (const [key, etag] of etagMap) {
        if (key.endsWith('.json')) {
            const gzKey = key + '.gz';
            if (etagMap.has(gzKey)) {
                deleteBatch.push({ Key: key });
                purged++;
            }
        }
    }

    // Process deletions in batches of 1000
    for (let i = 0; i < deleteBatch.length; i += 1000) {
        const batch = deleteBatch.slice(i, i + 1000);
        await s3.send(new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: batch }
        })).catch(e => console.error(`❌ Purge batch failed: ${e.message}`));
    }

    if (purged > 0) {
        console.log(`✅ Purged ${purged} artifacts of high entropy from R2.`);
    } else {
        console.log('✨ R2 Bucket is pristine. No entropy detected.');
    }
    return purged;
}
