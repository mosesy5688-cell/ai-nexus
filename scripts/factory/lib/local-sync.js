import fs from 'fs/promises';
import crypto from 'crypto';
import path from 'path';

/**
 * Local Sync Manifest Manager V1.0
 * Logic: Compare local hashes against a persistent manifest to skip R2 Class B listing.
 */

export async function loadLocalManifest(manifestPath) {
    try {
        const data = await fs.readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(data);
        console.log(`[LOCAL-SYNC] Loaded manifest with ${Object.keys(manifest.hashes || {}).length} entries.`);
        return manifest;
    } catch (e) {
        return { hashes: {}, version: '1.0', timestamp: Date.now() };
    }
}

export async function saveLocalManifest(manifestPath, manifest) {
    manifest.timestamp = Date.now();
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

export async function calculateHash(filePath) {
    try {
        const content = await fs.readFile(filePath);
        return crypto.createHash('md5').update(content).digest('hex');
    } catch (e) {
        return null;
    }
}
