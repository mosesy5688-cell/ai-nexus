/**
 * L5 License Parser V1.0
 * Phase B.8: User Understanding Infrastructure
 * 
 * Parses license_spdx field to determine commercial usability
 * 
 * Usage:
 *   node scripts/l5/license-parser.js data/entities.json data/enriched.json
 */

import fs from 'fs';

// Commercial-friendly licenses (can be used for commercial purposes)
const COMMERCIAL_LICENSES = new Set([
    'MIT',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'ISC',
    'Unlicense',
    'CC0-1.0',
    'WTFPL',
    'Zlib',
    'BSL-1.0',
    'PostgreSQL',
    'Apache-1.1',
    'Apache-1.0'
]);

// Copyleft licenses (require derivative works to be open source)
const COPYLEFT_LICENSES = new Set([
    'GPL-2.0',
    'GPL-3.0',
    'LGPL-2.1',
    'LGPL-3.0',
    'AGPL-3.0',
    'MPL-2.0'
]);

// Non-commercial licenses
const NON_COMMERCIAL_LICENSES = new Set([
    'CC-BY-NC-4.0',
    'CC-BY-NC-SA-4.0',
    'CC-BY-NC-ND-4.0',
    'Llama 2',
    'llama2',
    'creativeml-openrail-m' // Often includes non-commercial restrictions
]);

/**
 * Parse license and determine commercial usability
 */
function parseLicense(licenseSpdx) {
    if (!licenseSpdx) return { is_commercial: null, license_type: 'unknown' };

    const license = licenseSpdx.trim().toUpperCase();
    const licenseNorm = licenseSpdx.trim();

    // Check commercial
    for (const lic of COMMERCIAL_LICENSES) {
        if (license.includes(lic.toUpperCase())) {
            return { is_commercial: true, license_type: 'permissive' };
        }
    }

    // Check copyleft
    for (const lic of COPYLEFT_LICENSES) {
        if (license.includes(lic.toUpperCase())) {
            return { is_commercial: true, license_type: 'copyleft' };
        }
    }

    // Check non-commercial
    for (const lic of NON_COMMERCIAL_LICENSES) {
        if (license.includes(lic.toUpperCase())) {
            return { is_commercial: false, license_type: 'non-commercial' };
        }
    }

    // Default: unknown but likely restrictive
    return { is_commercial: null, license_type: 'unknown' };
}

/**
 * Calculate model activity status
 */
function getActivityStatus(lastModified) {
    if (!lastModified) return null;

    const now = new Date();
    const modified = new Date(lastModified);
    const daysSince = (now - modified) / (1000 * 60 * 60 * 24);

    if (daysSince <= 30) return 'active';      // Updated within 30 days
    if (daysSince <= 90) return 'maintained';  // Updated within 90 days
    if (daysSince <= 365) return 'stable';     // Updated within a year
    return 'legacy';                           // Not updated in over a year
}

/**
 * Process entities and add license/activity info
 */
function enrichLicenseInfo(entities) {
    let commercial = 0;
    let nonCommercial = 0;
    let unknown = 0;

    for (const entity of entities) {
        const license = entity.license_spdx;
        const licenseInfo = parseLicense(license);

        // Initialize meta structure
        if (!entity.meta_json) entity.meta_json = {};
        if (typeof entity.meta_json === 'string') {
            try { entity.meta_json = JSON.parse(entity.meta_json); }
            catch { entity.meta_json = {}; }
        }
        if (!entity.meta_json.extended) entity.meta_json.extended = {};

        // Add license info
        entity.meta_json.extended.is_commercial = licenseInfo.is_commercial;
        entity.meta_json.extended.license_type = licenseInfo.license_type;

        // Add activity status
        const activity = getActivityStatus(entity.last_modified || entity.last_updated);
        if (activity) entity.meta_json.extended.activity_status = activity;

        // Stats
        if (licenseInfo.is_commercial === true) commercial++;
        else if (licenseInfo.is_commercial === false) nonCommercial++;
        else unknown++;
    }

    console.log(`📜 License Parsing:`);
    console.log(`   ✅ Commercial: ${commercial}`);
    console.log(`   ❌ Non-Commercial: ${nonCommercial}`);
    console.log(`   ❓ Unknown: ${unknown}`);

    return entities;
}

/**
 * Main execution
 */
async function main() {
    const args = process.argv.slice(2);
    const inputPath = args[0] || 'data/entities.json';
    const outputPath = args[1] || 'data/entities_with_license.json';

    console.log('📜 L5 License Parser V1.0');
    console.log(`📄 Input: ${inputPath}`);
    console.log(`📄 Output: ${outputPath}`);

    if (!fs.existsSync(inputPath)) {
        console.error('❌ Input file not found:', inputPath);
        process.exit(1);
    }

    const entities = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    console.log(`📊 Loaded ${entities.length} entities`);

    const enrichedEntities = enrichLicenseInfo(entities);

    fs.writeFileSync(outputPath, JSON.stringify(enrichedEntities, null, 2));
    console.log(`✅ Written to: ${outputPath}`);
}

main().catch(err => {
    console.error('❌ License parsing failed:', err);
    process.exit(1);
});
