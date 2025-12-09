/**
 * R2-First Lakehouse: JSON Batch Generator
 * 
 * Creates JSON batches from merged.json for R2-First Lakehouse ingestion.
 * Follows V3.3 Constitution: Data Integrity + Lakehouse Architecture
 * 
 * Flow:
 *   merged.json → batch_001.json, batch_002.json, ... → R2 → Ingest API → D1
 * 
 * Configuration:
 *   - BATCH_SIZE: 25 items per batch (Worker 10ms CPU limit)
 *   - MAX_BATCH_SIZE_KB: 50KB per batch (R2 efficiency)
 * 
 * @module prepare-ingest-batches
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === Configuration ===
const CONFIG = {
    BATCH_SIZE: 25,           // Items per batch (Worker CPU limit)
    MAX_BATCH_SIZE_KB: 50,    // Max batch size in KB
    INPUT_FILE: path.join(__dirname, '../data/merged.json'),
    OUTPUT_DIR: path.join(__dirname, '../data/ingest'),
};

/**
 * Normalize model data for D1 schema compatibility
 * Maps orchestrator output fields to Ingest API expected fields
 */
function normalizeForD1(model) {
    return {
        // Core identification
        id: model.id || model.canonical_id,
        slug: model.slug || model.id?.replace(/\//g, '-'),
        name: model.name || model.id?.split('/')[1] || 'Unknown',
        author: model.author || model.id?.split('/')[0] || 'Unknown',

        // Content
        description: model.description || '',
        tags: JSON.stringify(model.tags || []),
        pipeline_tag: model.pipeline_tag || model.task || null,

        // Metrics
        likes: model.likes || 0,
        downloads: model.downloads || 0,

        // URLs
        cover_image_url: model.cover_image_url || null,
        raw_image_url: model.raw_image_url || model.image_url || null,
        body_content_url: model.body_content_url || null,

        // Audit Trail (V3.3 Constitution: Source Trail Required)
        source_trail: JSON.stringify(model.source_trail || {
            origin: model.source || 'unknown',
            collected_at: new Date().toISOString(),
            version: '3.3'
        }),

        // Commerce
        commercial_slots: model.commercial_slots ? JSON.stringify(model.commercial_slots) : null,

        // AI Enrichment
        notebooklm_summary: model.notebooklm_summary || null,

        // Velocity
        velocity_score: model.velocity_score || null,
        velocity: model.velocity || null,
        last_commercial_at: model.last_commercial_at || null,

        // Entity type (model, dataset, paper, tool)
        entity_type: model.type || 'model',

        // Search text (truncated for FTS)
        search_text: (model.body_content || model.description || '').substring(0, 2000),

        // Extended metadata
        meta_json: model.meta_json ? JSON.stringify(model.meta_json) : null,
        assets_json: model.assets_json ? JSON.stringify(model.assets_json) : null,
        relations_json: model.relations_json ? JSON.stringify(model.relations_json) : null,

        // Compliance & Quality
        canonical_id: model.canonical_id || model.id,
        license_spdx: model.license_spdx || model.license || null,
        compliance_status: model.compliance_status || 'ok',
        quality_score: model.quality_score || null,
        content_hash: model.content_hash || null,
    };
}

/**
 * Create batches from models array
 * Respects both item count and size limits
 */
function createBatches(models) {
    const batches = [];
    let currentBatch = [];
    let currentBatchSize = 0;

    for (const model of models) {
        const normalized = normalizeForD1(model);
        const modelSize = JSON.stringify(normalized).length;

        // Check if adding this model would exceed limits
        const wouldExceedItemLimit = currentBatch.length >= CONFIG.BATCH_SIZE;
        const wouldExceedSizeLimit = (currentBatchSize + modelSize) > CONFIG.MAX_BATCH_SIZE_KB * 1024;

        if (wouldExceedItemLimit || wouldExceedSizeLimit) {
            // Save current batch and start new one
            if (currentBatch.length > 0) {
                batches.push(currentBatch);
            }
            currentBatch = [normalized];
            currentBatchSize = modelSize;
        } else {
            currentBatch.push(normalized);
            currentBatchSize += modelSize;
        }
    }

    // Don't forget the last batch
    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }

    return batches;
}

/**
 * Main execution
 */
async function main() {
    console.log('🏗️  R2-First Lakehouse: JSON Batch Generator');
    console.log('─'.repeat(60));

    // 1. Verify input file exists
    if (!fs.existsSync(CONFIG.INPUT_FILE)) {
        console.error(`❌ Input file not found: ${CONFIG.INPUT_FILE}`);
        console.error('   Run orchestrator.js first to generate merged.json');
        process.exit(1);
    }

    // 2. Load merged.json
    console.log(`📥 Loading ${CONFIG.INPUT_FILE}...`);
    const rawData = fs.readFileSync(CONFIG.INPUT_FILE, 'utf-8');
    const models = JSON.parse(rawData);
    console.log(`   Total models: ${models.length}`);

    if (models.length === 0) {
        console.error('❌ No models found in merged.json');
        process.exit(1);
    }

    // 3. Create output directory
    if (!fs.existsSync(CONFIG.OUTPUT_DIR)) {
        fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true });
        console.log(`📁 Created output directory: ${CONFIG.OUTPUT_DIR}`);
    } else {
        // Clear existing batches
        const existingFiles = fs.readdirSync(CONFIG.OUTPUT_DIR).filter(f => f.startsWith('batch_'));
        for (const file of existingFiles) {
            fs.unlinkSync(path.join(CONFIG.OUTPUT_DIR, file));
        }
        console.log(`🧹 Cleared ${existingFiles.length} existing batch files`);
    }

    // 4. Create batches
    console.log(`\n📦 Creating batches (${CONFIG.BATCH_SIZE} items/batch, max ${CONFIG.MAX_BATCH_SIZE_KB}KB)...`);
    const batches = createBatches(models);
    console.log(`   Generated ${batches.length} batches`);

    // 5. Write batch files
    let totalItems = 0;
    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const batchId = String(i + 1).padStart(3, '0');
        const filename = `batch_${batchId}.json`;
        const filepath = path.join(CONFIG.OUTPUT_DIR, filename);

        fs.writeFileSync(filepath, JSON.stringify(batch, null, 2));

        const fileSize = fs.statSync(filepath).size;
        console.log(`   ✅ ${filename}: ${batch.length} items, ${(fileSize / 1024).toFixed(1)}KB`);
        totalItems += batch.length;
    }

    // 6. Create manifest
    const manifest = {
        version: '1.0.0',
        generated_at: new Date().toISOString(),
        source_file: 'merged.json',
        total_items: totalItems,
        total_batches: batches.length,
        batch_config: {
            items_per_batch: CONFIG.BATCH_SIZE,
            max_size_kb: CONFIG.MAX_BATCH_SIZE_KB
        },
        batches: batches.map((batch, i) => ({
            filename: `batch_${String(i + 1).padStart(3, '0')}.json`,
            count: batch.length
        }))
    };

    const manifestPath = path.join(CONFIG.OUTPUT_DIR, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`\n📋 Manifest written: ${manifestPath}`);

    // 7. Summary
    console.log('\n' + '─'.repeat(60));
    console.log('✅ R2-First Lakehouse Batch Generation Complete');
    console.log(`   📦 Total batches: ${batches.length}`);
    console.log(`   📊 Total items: ${totalItems}`);
    console.log(`   📁 Output: ${CONFIG.OUTPUT_DIR}`);
    console.log('\n🚀 Next steps:');
    console.log('   1. Upload batches to R2: npx wrangler r2 object put ...');
    console.log('   2. Call Ingest API: POST /api/admin/ingest');
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
