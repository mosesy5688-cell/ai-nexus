/**
 * R2 Upload Helpers V16.8.3
 * Extracted from r2-upload-s3.js for CES Compliance (Art 5.1)
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { rotateEntityVersions } from './entity-versioner.js';

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
 * Reliable upload with retries
 */
export async function uploadFile(s3, bucket, localPath, remotePath, remoteETag, retryCount = 0) {
    const MAX_RETRIES = 3;
    try {
        const content = await fs.readFile(localPath);
        const localMD5 = crypto.createHash('md5').update(content).digest('hex');

        if (localMD5 === remoteETag) {
            return { success: true, path: remotePath, skipped: true };
        }

        // V16.7: Strict WebP-Only Image Policy
        if (remotePath.startsWith('images/') && !remotePath.endsWith('.webp')) {
            return { success: true, path: remotePath, skipped: true, untracked: true };
        }

        const mimeMap = {
            '.json': 'application/json',
            '.xml': 'application/xml',
            '.gz': 'application/gzip',
            '.webp': 'image/webp',
            '.svg': 'image/svg+xml',
            '.txt': 'text/plain',
            '.html': 'text/html',
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
            ContentType: contentType
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
