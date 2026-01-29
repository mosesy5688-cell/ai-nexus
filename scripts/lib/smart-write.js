/**
 * V14.2 Smart Write Protocol
 * Zero-Cost Constitution Compliant
 * 
 * Reduces R2 Class A operations through:
 * 1. HEAD-before-PUT with ETag/SHA256 comparison
 * 2. Cache-Control headers on all uploads
 * 3. Gzip compression for JSON > 10KB
 * 
 * @module lib/smart-write
 */

import crypto from 'crypto';
import fs from 'fs';
import zlib from 'zlib';
import { promisify } from 'util';

const gzip = promisify(zlib.gzip);

// Constitution-mandated Cache-Control
const CACHE_CONTROL = 'public, max-age=3600';

/**
 * Compute SHA256 hash of content
 */
export function computeSHA256(content) {
    if (Buffer.isBuffer(content)) {
        return crypto.createHash('sha256').update(content).digest('hex');
    }
    if (typeof content === 'string') {
        return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    }
    // For objects, stringify first
    return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/**
 * Smart Write: HEAD-before-PUT with hash comparison
 * 
 * @param {R2Bucket} bucket - R2 bucket binding
 * @param {string} key - Object key
 * @param {any} content - Content to write
 * @param {Object} options - Additional options
 * @returns {Object} Result with written/skipped status
 */
export async function smartWrite(bucket, key, content, options = {}) {
    const startTime = Date.now();

    // Prepare content
    let body = content;
    let contentType = options.contentType || 'application/json';
    let contentEncoding = null;

    // Stringify if object
    if (typeof content === 'object' && !Buffer.isBuffer(content)) {
        body = JSON.stringify(content);
    }

    // Calculate hash of new content
    const newHash = computeSHA256(body);

    // 1. HEAD check - get existing object metadata
    try {
        const existing = await bucket.head(key);

        if (existing) {
            // Compare using ETag or custom SHA256 metadata
            const existingHash = existing.customMetadata?.sha256 ||
                existing.etag?.replace(/"/g, '');

            if (existingHash === newHash) {
                console.log(`⏭️ [SmartWrite] SKIP: ${key} (hash match)`);
                return {
                    written: false,
                    skipped: true,
                    reason: 'hash_match',
                    hash: newHash,
                    duration: Date.now() - startTime
                };
            }
        }
    } catch (err) {
        // HEAD failed, continue with PUT (object may not exist)
        console.log(`ℹ️ [SmartWrite] HEAD failed for ${key}, proceeding with PUT`);
    }

    // 2. Gzip compress if JSON and > 10KB
    if (contentType === 'application/json' && body.length > 10240) {
        const compressed = await gzip(Buffer.from(body));
        body = compressed;
        contentEncoding = 'gzip';
        console.log(`🗜️ [SmartWrite] Compressed: ${key} (${(body.length / 1024).toFixed(1)}KB)`);
    }

    // 3. PUT with Cache-Control and metadata
    await bucket.put(key, body, {
        httpMetadata: {
            contentType,
            contentEncoding,
            cacheControl: CACHE_CONTROL
        },
        customMetadata: {
            sha256: newHash,
            uploadedAt: new Date().toISOString(),
            v: '14.2' // Version marker
        }
    });

    const duration = Date.now() - startTime;
    console.log(`✅ [SmartWrite] PUT: ${key} (${duration}ms)`);

    return {
        written: true,
        skipped: false,
        hash: newHash,
        compressed: !!contentEncoding,
        duration
    };
}

/**
 * Smart Write batch of files
 */
export async function smartWriteBatch(bucket, items) {
    const results = {
        written: 0,
        skipped: 0,
        failed: 0,
        details: []
    };

    for (const item of items) {
        try {
            const result = await smartWrite(bucket, item.key, item.content, item.options);

            if (result.written) results.written++;
            if (result.skipped) results.skipped++;

            results.details.push({ key: item.key, ...result, success: true });
        } catch (err) {
            console.error(`❌ [SmartWrite] Failed: ${item.key} - ${err.message}`);
            results.failed++;
            results.details.push({ key: item.key, success: false, error: err.message });
        }
    }

    console.log(`📊 [SmartWrite] Batch complete: ${results.written} written, ${results.skipped} skipped, ${results.failed} failed`);
    return results;
}

/**
 * Wrangler CLI version of Smart Write (for GitHub Actions)
 * Uses npx wrangler r2 object commands
 */
export async function smartWriteWrangler(bucketName, key, localFile, options = {}) {
    const { execSync } = await import('child_process');

    // Read file and compute hash
    const content = fs.readFileSync(localFile);
    const newHash = computeSHA256(content);

    // Check if object exists with same hash
    try {
        const headResult = execSync(
            `npx wrangler r2 object head ${bucketName}/${key} --json --remote 2>/dev/null`,
            { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        );

        const metadata = JSON.parse(headResult);
        const existingHash = metadata.customMetadata?.sha256;

        if (existingHash === newHash) {
            console.log(`⏭️ [SmartWrite] SKIP: ${key} (hash match)`);
            return { written: false, skipped: true, hash: newHash };
        }
    } catch (err) {
        // HEAD failed, object doesn't exist or error - continue with PUT
    }

    // Determine content type
    const ext = localFile.split('.').pop();
    const contentType = ext === 'json' ? 'application/json' :
        ext === 'gz' ? 'application/gzip' :
            'application/octet-stream';

    // PUT with cache-control
    execSync(
        `npx wrangler r2 object put "${bucketName}/${key}" --file="${localFile}" --content-type="${contentType}" --cache-control="${CACHE_CONTROL}" --remote`,
        { stdio: 'inherit' }
    );

    console.log(`✅ [SmartWrite] PUT: ${key}`);
    return { written: true, skipped: false, hash: newHash };
}

export default {
    computeSHA256,
    smartWrite,
    smartWriteBatch,
    smartWriteWrangler,
    CACHE_CONTROL
};
