/**
 * Search Index Generator
 * 
 * B.17 P1: Generate lightweight search-index.json for client-side fuzzy search
 * V1.1-LOCK: Manifest enforcement enabled
 * 
 * Output: public/data/search-index.json (gzipped for R2)
 * Format: Minimal fields for fast client-side search
 * 
 * Constitution V4.3.2 Compliance:
 * - Web Worker timebox: 50ms target
 * - Max index size: 500KB gzipped
 * 
 * @module l5/search-index
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { enforceUpstreamComplete } from './manifest-utils.js';

// V1.1-LOCK: Enforce upstream manifest completeness
const L1_MANIFEST = 'data/manifest.json';
if (fs.existsSync(L1_MANIFEST)) {
    try { enforceUpstreamComplete(L1_MANIFEST); }
    catch (e) { console.error('⛔ Manifest Enforcement:', e.message); process.exit(1); }
}

const DATA_DIR = process.env.DATA_DIR || './data';
const OUTPUT_DIR = process.env.OUTPUT_DIR || './public/data';

/**
 * Load entities from merged file
 */
function loadEntities() {
    const entitiesPath = path.join(DATA_DIR, 'entities.json');

    if (!fs.existsSync(entitiesPath)) {
        // Try gzipped version
        const gzPath = path.join(DATA_DIR, 'entities.json.gz');
        if (fs.existsSync(gzPath)) {
            const compressed = fs.readFileSync(gzPath);
            const json = zlib.gunzipSync(compressed).toString('utf-8');
            return JSON.parse(json);
        }
        console.error('❌ No entities file found');
        return [];
    }

    return JSON.parse(fs.readFileSync(entitiesPath, 'utf-8'));
}

/**
 * Extract searchable text from entity
 * @param {Object} entity 
 */
function extractSearchText(entity) {
    const parts = [
        entity.name || '',
        entity.author || '',
        entity.description?.substring(0, 200) || '',  // Truncate for size
        entity.pipeline_tag || '',
        entity.primary_category || ''
    ];

    // Add tags if available
    if (entity.tags) {
        const tagsStr = typeof entity.tags === 'string'
            ? entity.tags
            : entity.tags.join?.(',') || '';
        parts.push(tagsStr.substring(0, 100));
    }

    return parts.filter(Boolean).join(' ').toLowerCase();
}

/**
 * Generate minimal search index entry
 * @param {Object} entity 
 * @param {number} rank
 */
function toSearchEntry(entity, rank) {
    return {
        i: entity.id || entity.umid,                    // id
        n: entity.name || '',                           // name
        a: entity.author || '',                         // author
        t: entity.type || 'model',                      // type
        c: entity.primary_category || '',               // category
        s: entity.source || '',                         // source
        f: Math.round(entity.fni_score || 0),           // fni score (integer)
        r: rank,                                        // rank
        _: extractSearchText(entity)                    // search text
    };
}

/**
 * Main search index generation
 */
async function generateSearchIndex() {
    console.log('🔍 [Search Index] Starting generation...\n');

    // Load entities
    const entities = loadEntities();
    console.log(`📦 Loaded ${entities.length} entities\n`);

    if (entities.length === 0) {
        console.error('❌ No entities to index');
        process.exit(1);
    }

    // Sort by FNI score for ranking
    const sorted = entities.sort((a, b) =>
        (b.fni_score || 0) - (a.fni_score || 0)
    );

    // Generate index entries
    console.log('⚙️ Generating search entries...');
    const searchIndex = sorted.map((entity, idx) => toSearchEntry(entity, idx + 1));

    // Calculate stats
    const byType = {};
    const byCategory = {};
    const bySource = {};

    searchIndex.forEach(e => {
        byType[e.t] = (byType[e.t] || 0) + 1;
        if (e.c) byCategory[e.c] = (byCategory[e.c] || 0) + 1;
        if (e.s) bySource[e.s] = (bySource[e.s] || 0) + 1;
    });

    // Create output structure
    const output = {
        version: '1.0',
        generated: new Date().toISOString(),
        count: searchIndex.length,
        stats: {
            byType,
            byCategory: Object.fromEntries(
                Object.entries(byCategory).sort((a, b) => b[1] - a[1]).slice(0, 20)
            ),
            bySource
        },
        entries: searchIndex
    };

    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // Write uncompressed JSON
    const jsonPath = path.join(OUTPUT_DIR, 'search-index.json');
    const jsonStr = JSON.stringify(output);
    fs.writeFileSync(jsonPath, jsonStr);

    // Write gzipped version
    const gzPath = path.join(OUTPUT_DIR, 'search-index.json.gz');
    const compressed = zlib.gzipSync(jsonStr);
    fs.writeFileSync(gzPath, compressed);

    // Report
    const jsonSize = (Buffer.byteLength(jsonStr) / 1024).toFixed(1);
    const gzSize = (compressed.length / 1024).toFixed(1);

    console.log(`\n✅ [Search Index] Generated successfully!`);
    console.log(`   📊 Entries: ${searchIndex.length}`);
    console.log(`   📁 JSON: ${jsonSize} KB`);
    console.log(`   📦 Gzipped: ${gzSize} KB`);
    console.log(`   📍 Output: ${jsonPath}`);

    // Warn if too large
    if (compressed.length > 500 * 1024) {
        console.warn(`\n⚠️ WARNING: Gzipped size ${gzSize}KB exceeds 500KB limit!`);
        console.warn('   Consider reducing entry fields or truncating descriptions');
    }

    // Stats summary
    console.log('\n📈 Stats:');
    console.log(`   Types: ${Object.keys(byType).join(', ')}`);
    console.log(`   Sources: ${Object.keys(bySource).join(', ')}`);
    console.log(`   Top Categories: ${Object.keys(byCategory).slice(0, 5).join(', ')}`);

    return output;
}

// Run if called directly
generateSearchIndex().catch(err => {
    console.error('❌ Error:', err);
    process.exit(1);
});
