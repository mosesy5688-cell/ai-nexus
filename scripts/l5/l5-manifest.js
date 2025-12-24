/**
 * L5 Manifest Output Utility
 * 
 * Generates INTEGRITY-V1.1 manifest for L5 stage output
 * Used by rankings-compute, similarity-compute, search-index, etc.
 * 
 * @module l5/l5-manifest
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

/**
 * Initialize L5 manifest
 * @param {string} stage - L5 sub-stage name (e.g., 'rankings', 'similarity')
 * @returns {Object} Manifest object
 */
export function initL5Manifest(stage) {
    return {
        version: 'INTEGRITY-V1.1',
        stage: `L5-${stage}`,
        job_id: process.env.GITHUB_RUN_ID || Date.now().toString(),
        started_at: new Date().toISOString(),
        completed_at: null,
        status: 'running',
        input: {
            manifest_ref: 'ingest/manifest.json',
            entities_path: 'data/entities.json'
        },
        output: {
            type: 'local',
            files: [],
            total_files: 0
        },
        checksum: null
    };
}

/**
 * Record output file in manifest
 * @param {Object} manifest 
 * @param {string} filePath 
 * @param {number} size 
 */
export function recordOutputFile(manifest, filePath, size) {
    const content = fs.existsSync(filePath)
        ? fs.readFileSync(filePath)
        : Buffer.from('');
    const hash = createHash('sha256').update(content).digest('hex');

    manifest.output.files.push({
        path: filePath,
        size,
        hash
    });
    manifest.output.total_files++;
}

/**
 * Finalize manifest with checksum
 * @param {Object} manifest 
 * @returns {Object} Finalized manifest
 */
export function finalizeL5Manifest(manifest) {
    manifest.completed_at = new Date().toISOString();
    manifest.status = 'complete';

    // Compute total_hash from all output file hashes
    const allHashes = manifest.output.files
        .map(f => f.hash)
        .sort()
        .join('');

    manifest.checksum = {
        algorithm: 'sha256',
        mode: 'ordered-concat',
        total_hash: 'sha256:' + createHash('sha256').update(allHashes).digest('hex')
    };

    return manifest;
}

/**
 * Write L5 manifest to file
 * @param {Object} manifest 
 * @param {string} outputDir 
 */
export function writeL5Manifest(manifest, outputDir) {
    const manifestPath = path.join(outputDir, `l5-${manifest.stage.replace('L5-', '')}-manifest.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`✅ L5 Manifest written: ${manifestPath}`);
    return manifestPath;
}

export default { initL5Manifest, recordOutputFile, finalizeL5Manifest, writeL5Manifest };
