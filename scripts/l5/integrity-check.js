/**
 * Data Integrity Check Script
 * 
 * V1.1-LOCK: Validates manifest integrity across all stages
 * - Verifies total_hash is the ONLY valid checksum
 * - Detects illegal hash fields
 * - Validates manifest status
 * 
 * @module l5/integrity-check
 */

import fs from 'fs';
import path from 'path';
import { computeTotalHash } from './manifest-utils.js';

const MANIFEST_PATHS = [
    'data/manifest.json',           // L5 local manifest
    // R2 manifests would be fetched via API
];

/**
 * Validate a single manifest
 */
function validateManifest(manifestPath) {
    const results = {
        path: manifestPath,
        exists: false,
        valid: false,
        errors: [],
        warnings: []
    };

    if (!fs.existsSync(manifestPath)) {
        results.errors.push('Manifest file not found');
        return results;
    }

    results.exists = true;

    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

        // Check version
        if (!manifest.version) {
            results.errors.push('Missing version field');
        } else if (!manifest.version.startsWith('INTEGRITY-')) {
            results.warnings.push(`Non-standard version: ${manifest.version}`);
        }

        // Check status
        if (manifest.status !== 'complete') {
            results.errors.push(`Status is "${manifest.status}", expected "complete"`);
        }

        // Check total_hash
        if (!manifest.checksum?.total_hash) {
            results.errors.push('Missing checksum.total_hash');
        } else {
            // Verify total_hash calculation
            const computed = computeTotalHash(manifest);
            if (manifest.checksum.total_hash !== computed) {
                results.errors.push(`total_hash mismatch: expected ${computed}, got ${manifest.checksum.total_hash}`);
            }
        }

        // Check for illegal hash fields (not in checksum block)
        const illegalHashFields = ['hash', 'md5', 'sha1', 'content_hash'];
        for (const field of illegalHashFields) {
            if (manifest[field]) {
                results.warnings.push(`Illegal top-level hash field detected: ${field}`);
            }
        }

        // Validate batches have hashes
        if (manifest.batches?.length > 0) {
            const batchesWithoutHash = manifest.batches.filter(b => !b.hash);
            if (batchesWithoutHash.length > 0) {
                results.warnings.push(`${batchesWithoutHash.length} batches missing hash`);
            }
        }

        results.valid = results.errors.length === 0;

    } catch (err) {
        results.errors.push(`Parse error: ${err.message}`);
    }

    return results;
}

/**
 * Main integrity check
 */
async function runIntegrityCheck() {
    console.log('🔍 Data Integrity Check V1.1-LOCK\n');
    console.log('='.repeat(50));

    const allResults = [];
    let hasErrors = false;

    for (const manifestPath of MANIFEST_PATHS) {
        console.log(`\n📋 Checking: ${manifestPath}`);
        const result = validateManifest(manifestPath);
        allResults.push(result);

        if (!result.exists) {
            console.log('   ⚪ Not found (skipped)');
            continue;
        }

        if (result.valid) {
            console.log('   ✅ Valid');
        } else {
            console.log('   ❌ Invalid');
            hasErrors = true;
        }

        for (const error of result.errors) {
            console.log(`   ❌ ERROR: ${error}`);
        }

        for (const warning of result.warnings) {
            console.log(`   ⚠️ WARNING: ${warning}`);
        }
    }

    console.log('\n' + '='.repeat(50));
    console.log('📊 Summary:');
    console.log(`   Checked: ${allResults.length} manifests`);
    console.log(`   Valid: ${allResults.filter(r => r.valid).length}`);
    console.log(`   Invalid: ${allResults.filter(r => !r.valid && r.exists).length}`);
    console.log(`   Not found: ${allResults.filter(r => !r.exists).length}`);

    if (hasErrors) {
        console.log('\n❌ INTEGRITY CHECK FAILED');
        process.exit(1);
    } else {
        console.log('\n✅ INTEGRITY CHECK PASSED');
    }

    return allResults;
}

// Run if called directly
runIntegrityCheck().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});

export { validateManifest, runIntegrityCheck };
