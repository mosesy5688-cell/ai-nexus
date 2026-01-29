/**
 * L5 Update R2 Cache with Similarity Data
 * 
 * This script reads the entities_with_similarity.json file and updates
 * corresponding R2 cache files with similar_models data.
 * 
 * @module l5/similarity-to-r2
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import zlib from 'zlib';

const R2_BUCKET = 'ai-nexus-assets';

/**
 * Generate R2 cache path from entity ID
 */
function getCachePath(entity) {
    const slug = entity.slug || entity.id.replace(/\//g, '--');
    // V11: Unified Constitutional Cache Path
    // All entities use cache/entities/{type}/{slug}.json structure
    const type = entity.type || 'model';
    return `cache/entities/${type}/${slug}.json`;
}

/**
 * Download existing cache file from R2
 */
function downloadFromR2(r2Path) {
    const tempFile = `/tmp/r2_${Date.now()}.json`;
    try {
        execSync(`npx wrangler r2 object get ${R2_BUCKET} ${r2Path} --file ${tempFile}`, {
            stdio: 'pipe'
        });

        // Try to decompress if gzipped
        const content = fs.readFileSync(tempFile);
        try {
            const decompressed = zlib.gunzipSync(content);
            return JSON.parse(decompressed.toString());
        } catch {
            // Not gzipped, parse directly
            return JSON.parse(content.toString());
        }
    } catch (err) {
        return null; // File doesn't exist
    } finally {
        try { fs.unlinkSync(tempFile); } catch { }
    }
}

/**
 * Upload updated cache file to R2
 */
function uploadToR2(r2Path, data) {
    const tempFile = `/tmp/r2_upload_${Date.now()}.json`;
    const compressed = zlib.gzipSync(JSON.stringify(data));
    fs.writeFileSync(tempFile, compressed);

    try {
        execSync(`npx -y wrangler r2 object put ${R2_BUCKET} ${r2Path} --file ${tempFile}`, {
            stdio: 'pipe'
        });
        return true;
    } catch (err) {
        console.error(`Failed to upload ${r2Path}:`, err.message);
        return false;
    } finally {
        try { fs.unlinkSync(tempFile); } catch { }
    }
}

/**
 * Main function to update R2 cache with similarity data
 */
export async function updateR2WithSimilarity(entitiesFile) {
    console.log(`🧠 Updating R2 cache with similarity data from ${entitiesFile}...`);

    if (!fs.existsSync(entitiesFile)) {
        console.error(`❌ Entities file not found: ${entitiesFile}`);
        return 0;
    }

    const entities = JSON.parse(fs.readFileSync(entitiesFile, 'utf8'));
    console.log(`📊 Loaded ${entities.length} entities`);

    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    // Only process entities with similar_models
    const entitiesWithSimilarity = entities.filter(e =>
        e.meta_json?.similar_models &&
        Array.isArray(e.meta_json.similar_models) &&
        e.meta_json.similar_models.length > 0
    );

    console.log(`🔍 Found ${entitiesWithSimilarity.length} entities with similarity data`);

    // Batch process to avoid rate limits
    const BATCH_SIZE = 50;
    for (let i = 0; i < entitiesWithSimilarity.length; i += BATCH_SIZE) {
        const batch = entitiesWithSimilarity.slice(i, i + BATCH_SIZE);
        console.log(`   Processing batch ${i / BATCH_SIZE + 1}/${Math.ceil(entitiesWithSimilarity.length / BATCH_SIZE)}`);

        for (const entity of batch) {
            const cachePath = getCachePath(entity);

            // Download existing cache
            const existingCache = downloadFromR2(cachePath);

            if (!existingCache) {
                skippedCount++;
                continue;
            }

            // Update with similarity data
            if (!existingCache.entity) {
                skippedCount++;
                continue;
            }

            // Add similar_models to entity
            existingCache.entity.similar_models = entity.meta_json.similar_models;

            // Update version
            existingCache.version = 'V8.0-similarity';
            existingCache.similarity_updated_at = new Date().toISOString();

            // Upload back to R2
            if (uploadToR2(cachePath, existingCache)) {
                updatedCount++;
            } else {
                errorCount++;
            }
        }

        // Brief pause between batches
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`\n✅ Summary:`);
    console.log(`   Updated: ${updatedCount}`);
    console.log(`   Skipped: ${skippedCount}`);
    console.log(`   Errors: ${errorCount}`);

    return updatedCount;
}

// CLI execution
if (process.argv[1].includes('similarity-to-r2')) {
    const inputFile = process.argv[2] || 'data/entities_with_similarity.json';

    updateR2WithSimilarity(inputFile)
        .then(count => {
            console.log(`\n🎉 Done! Updated ${count} R2 cache files.`);
        })
        .catch(err => {
            console.error('❌ Error:', err.message);
            process.exit(1);
        });
}
