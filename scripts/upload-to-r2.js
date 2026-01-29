/**
 * V4.1 R2 Raw Data Uploader
 * 
 * Purpose: Upload merged.json to R2 as raw-data batches
 * This is the "Dump & Go" step in V4.1 architecture
 * 
 * The Unified Cloudflare Workflow will handle:
 * - Data cleaning
 * - FNI calculation
 * - D1 ingestion
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const CONFIG = {
    MERGED_JSON_PATH: path.join(__dirname, '../data/merged.json'),
    BATCH_SIZE: 50,  // Models per batch file
    R2_BUCKET: 'ai-nexus-assets',
    R2_PREFIX: 'raw-data/'
};

/**
 * Split models into batches
 */
function splitIntoBatches(models, batchSize) {
    const batches = [];
    for (let i = 0; i < models.length; i += batchSize) {
        batches.push(models.slice(i, i + batchSize));
    }
    return batches;
}

/**
 * Generate batch filename with timestamp
 */
function generateBatchFilename(index) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `${timestamp}_batch_${String(index).padStart(3, '0')}.json`;
}

/**
 * Upload batch to R2 using wrangler
 */
async function uploadBatchToR2(batch, filename) {
    const tempPath = path.join(__dirname, '../data/temp_batch.json');

    // Write batch to temp file
    fs.writeFileSync(tempPath, JSON.stringify(batch, null, 2));

    const r2Key = `${CONFIG.R2_PREFIX}${filename}`;

    // Use wrangler to upload
    const { execSync } = await import('child_process');
    try {
        execSync(
            `npx wrangler r2 object put "${CONFIG.R2_BUCKET}" "${r2Key}" --file="${tempPath}" --content-type="application/json" ${process.argv.includes('--remote') ? '--remote' : ''}`,
            {
                cwd: path.join(__dirname, '..'),
                stdio: 'inherit'
            }
        );
        console.log(`✅ Uploaded: ${r2Key} (${batch.length} models)`);
        return true;
    } catch (error) {
        console.error(`❌ Failed to upload ${r2Key}:`, error.message);
        return false;
    } finally {
        // Cleanup temp file
        if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
        }
    }
}

/**
 * Main function
 */
async function main() {
    console.log('🚀 V4.1 R2 Raw Data Uploader');
    console.log('='.repeat(50));

    // 1. Check if merged.json exists
    if (!fs.existsSync(CONFIG.MERGED_JSON_PATH)) {
        console.error('❌ Error: merged.json not found. Run orchestrator first.');
        process.exit(1);
    }

    // 2. Load merged.json
    console.log('📂 Loading merged.json...');
    const models = JSON.parse(fs.readFileSync(CONFIG.MERGED_JSON_PATH, 'utf-8'));
    console.log(`   Found ${models.length} models`);

    // 3. Split into batches
    const batches = splitIntoBatches(models, CONFIG.BATCH_SIZE);
    console.log(`📦 Split into ${batches.length} batches (${CONFIG.BATCH_SIZE} per batch)`);

    // 4. Upload each batch to R2
    console.log(`\n☁️  Uploading to R2 (${CONFIG.R2_BUCKET}/${CONFIG.R2_PREFIX})...`);

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < batches.length; i++) {
        const filename = generateBatchFilename(i);
        const success = await uploadBatchToR2(batches[i], filename);

        if (success) {
            successCount++;
        } else {
            failCount++;
        }

        // Small delay to avoid rate limiting
        if (i < batches.length - 1) {
            await new Promise(r => setTimeout(r, 500));
        }
    }

    // 5. Summary
    console.log('\n' + '='.repeat(50));
    console.log('📊 Upload Summary:');
    console.log(`   ✅ Successful: ${successCount} batches`);
    console.log(`   ❌ Failed: ${failCount} batches`);
    console.log(`   📦 Total models: ${models.length}`);
    console.log('');
    console.log('🔄 Next: Unified Workflow will process raw-data/ → D1');
    console.log('='.repeat(50));

    if (failCount > 0) {
        process.exit(1);
    }
}

// Run
main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
