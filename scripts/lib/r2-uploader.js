/**
 * R2 Uploader with Resume Support
 * 
 * B.12 Data Transfer Protocol
 * - SHA256 hash verification
 * - Manifest tracking
 * - Retry with exponential backoff
 * 
 * @module lib/r2-uploader
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const MAX_RETRIES = 3;
const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Compute SHA256 hash of a file
 */
export async function computeSHA256(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', data => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

/**
 * Load manifest from R2 or local
 */
export async function loadManifest(r2Bucket, manifestKey = 'computed/manifest.json') {
    try {
        const obj = await r2Bucket.get(manifestKey);
        if (obj) {
            const text = await obj.text();
            return JSON.parse(text);
        }
    } catch (err) {
        console.log('No existing manifest, starting fresh');
    }
    return { files: [], timestamp: null, status: 'empty' };
}

/**
 * Upload file with resume support
 */
export async function uploadWithResume(r2Bucket, localFile, r2Key, manifest) {
    const fileHash = await computeSHA256(localFile);
    const fileSize = fs.statSync(localFile).size;

    // Check if already exists with same hash
    const existing = manifest.files.find(f => f.key === r2Key);
    if (existing && existing.hash === fileHash) {
        console.log(`⏭️ Skip: ${r2Key} (hash match)`);
        return { skipped: true, hash: fileHash, size: fileSize };
    }

    // Upload with retries
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const content = fs.readFileSync(localFile);
            await r2Bucket.put(r2Key, content, {
                httpMetadata: {
                    contentType: 'application/json',
                    contentEncoding: fileSize > 100000 ? 'gzip' : undefined
                },
                customMetadata: {
                    sha256: fileHash,
                    uploadedAt: new Date().toISOString()
                }
            });

            console.log(`✅ Uploaded: ${r2Key} (${(fileSize / 1024).toFixed(1)}KB)`);
            return { uploaded: true, hash: fileHash, size: fileSize };

        } catch (err) {
            console.error(`❌ Attempt ${attempt} failed: ${err.message}`);
            if (attempt === MAX_RETRIES) {
                throw err;
            }
            // Exponential backoff
            await delay(5000 * attempt);
        }
    }
}

/**
 * Upload multiple files safely
 */
export async function safeUploadBatch(r2Bucket, files, manifest) {
    const results = [];
    const updatedFiles = [...manifest.files];

    for (const file of files) {
        try {
            const result = await uploadWithResume(r2Bucket, file.local, file.r2Key, manifest);

            // Update manifest entry
            const idx = updatedFiles.findIndex(f => f.key === file.r2Key);
            const entry = {
                key: file.r2Key,
                hash: result.hash,
                size: result.size,
                uploadedAt: new Date().toISOString(),
                entities_count: file.entities_count || 0
            };

            if (idx >= 0) {
                updatedFiles[idx] = entry;
            } else {
                updatedFiles.push(entry);
            }

            results.push({ ...file, ...result, success: true });

        } catch (err) {
            console.error(`❌ Failed: ${file.r2Key} - ${err.message}`);
            results.push({ ...file, success: false, error: err.message });
        }
    }

    // Update manifest
    const failed = results.filter(r => !r.success);
    const newManifest = {
        timestamp: new Date().toISOString(),
        job_id: process.env.GITHUB_RUN_ID || 'local',
        files: updatedFiles,
        total_entities: updatedFiles.reduce((sum, f) => sum + (f.entities_count || 0), 0),
        status: failed.length > 0 ? 'partial' : 'complete'
    };

    await r2Bucket.put('computed/manifest.json', JSON.stringify(newManifest, null, 2));

    return { results, manifest: newManifest, failed: failed.length };
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export default {
    computeSHA256,
    loadManifest,
    uploadWithResume,
    safeUploadBatch
};
