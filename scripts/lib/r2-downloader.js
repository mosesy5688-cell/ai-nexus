/**
 * R2 Downloader with Verification
 * 
 * B.12 Data Transfer Protocol
 * - SHA256 hash verification
 * - Manifest-based integrity check
 * 
 * @module lib/r2-downloader
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

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
 * Fetch manifest from R2
 */
export async function fetchManifest(r2Bucket, manifestKey = 'computed/manifest.json') {
    const obj = await r2Bucket.get(manifestKey);
    if (!obj) {
        throw new Error('Manifest not found');
    }
    return JSON.parse(await obj.text());
}

/**
 * Download and verify file from R2
 */
export async function downloadWithVerify(r2Bucket, r2Key, localPath, manifest) {
    const expected = manifest.files.find(f => f.key === r2Key);

    // Download
    const obj = await r2Bucket.get(r2Key);
    if (!obj) {
        throw new Error(`File not found: ${r2Key}`);
    }

    const data = await obj.arrayBuffer();
    const buffer = Buffer.from(data);

    // Ensure directory exists
    const dir = path.dirname(localPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(localPath, buffer);

    // Verify hash if available
    if (expected && expected.hash) {
        const actualHash = await computeSHA256(localPath);
        if (actualHash !== expected.hash) {
            fs.unlinkSync(localPath); // Remove corrupted file
            throw new Error(`Hash mismatch for ${r2Key}: expected ${expected.hash}, got ${actualHash}`);
        }
        console.log(`✅ Verified: ${r2Key}`);
    } else {
        console.log(`⚠️ Downloaded (no hash): ${r2Key}`);
    }

    return { verified: !!expected?.hash, size: buffer.length };
}

/**
 * Download all files from manifest
 */
export async function downloadAll(r2Bucket, manifest, localDir) {
    const results = [];

    for (const file of manifest.files) {
        const localPath = path.join(localDir, file.key);

        try {
            const result = await downloadWithVerify(r2Bucket, file.key, localPath, manifest);
            results.push({ key: file.key, ...result, success: true });
        } catch (err) {
            console.error(`❌ Failed: ${file.key} - ${err.message}`);
            results.push({ key: file.key, success: false, error: err.message });
        }
    }

    return results;
}

export default {
    computeSHA256,
    fetchManifest,
    downloadWithVerify,
    downloadAll
};
