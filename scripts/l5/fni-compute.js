/**
 * L5 FNI Compute Script
 * 
 * B.11 Heavy Computation Migration
 * Runs in GitHub Actions Sidecar for 500K-1M scale
 * 
 * @module l5/fni-compute
 */

import fs from 'fs';
import path from 'path';

const BATCH_SIZE = 50000; // 50K entities per batch

/**
 * FNI Calculation Weights (V6.0)
 */
const FNI_WEIGHTS = {
    popularity: 0.30,    // P: likes, downloads
    velocity: 0.20,      // V: growth rate
    completeness: 0.25,  // C: README, params, config
    utility: 0.25        // U: GGUF, license, tags
};

/**
 * Calculate Popularity Score (0-100)
 */
function calculatePopularity(entity) {
    const likes = entity.likes || 0;
    const downloads = entity.downloads || 0;

    // Log scale for wide range
    const likeScore = Math.min(100, Math.log10(Math.max(1, likes)) * 25);
    const downloadScore = Math.min(100, Math.log10(Math.max(1, downloads)) * 15);

    return (likeScore * 0.4 + downloadScore * 0.6);
}

/**
 * Calculate Velocity Score (0-100)
 */
function calculateVelocity(entity) {
    const lastModified = entity.last_modified ? new Date(entity.last_modified) : null;
    if (!lastModified) return 30; // Default for unknown

    const daysSinceUpdate = (Date.now() - lastModified.getTime()) / (1000 * 60 * 60 * 24);

    if (daysSinceUpdate < 7) return 100;
    if (daysSinceUpdate < 30) return 80;
    if (daysSinceUpdate < 90) return 60;
    if (daysSinceUpdate < 365) return 40;
    return 20;
}

/**
 * Calculate Completeness Score (0-100)
 */
function calculateCompleteness(entity) {
    let score = 0;

    // Has description/body
    if (entity.body_content && entity.body_content.length > 100) score += 30;
    else if (entity.description && entity.description.length > 50) score += 15;

    // Has parameters info
    if (entity.params_billions) score += 20;

    // Has tags
    if (entity.tags && entity.tags.length > 0) score += 15;

    // Has source URL
    if (entity.source_url) score += 10;

    // Has category
    if (entity.primary_category) score += 15;

    // Has author
    if (entity.author) score += 10;

    return Math.min(100, score);
}

/**
 * Calculate Utility Score (0-100)
 */
function calculateUtility(entity) {
    let score = 30; // Base score

    // Has GGUF (easy deployment)
    if (entity.has_gguf) score += 25;

    // Has permissive license
    const permissiveLicenses = ['mit', 'apache', 'apache-2.0', 'bsd', 'cc0', 'unlicense'];
    if (entity.license && permissiveLicenses.some(l => entity.license.toLowerCase().includes(l))) {
        score += 20;
    }

    // Has spaces/demos
    if (entity.spaces_count > 0) score += 15;

    // Source reputation
    if (entity.source === 'huggingface') score += 10;

    return Math.min(100, score);
}

/**
 * Calculate FNI Score for single entity
 */
function calculateFNI(entity) {
    const P = calculatePopularity(entity);
    const V = calculateVelocity(entity);
    const C = calculateCompleteness(entity);
    const U = calculateUtility(entity);

    const fni = (
        FNI_WEIGHTS.popularity * P +
        FNI_WEIGHTS.velocity * V +
        FNI_WEIGHTS.completeness * C +
        FNI_WEIGHTS.utility * U
    );

    return {
        fni_score: Math.round(fni * 10) / 10,
        fni_breakdown: { P: Math.round(P), V: Math.round(V), C: Math.round(C), U: Math.round(U) }
    };
}

/**
 * Process all entities and compute FNI
 */
export async function computeAllFNI(inputFile, outputDir) {
    console.log(`📊 Loading entities from ${inputFile}...`);
    const allEntities = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    console.log(`📦 Loaded ${allEntities.length} total entities`);

    // FNI only applies to models and agents (not papers, datasets)
    const FNI_ENTITY_TYPES = ['model', 'agent'];
    const entities = allEntities.filter(e =>
        FNI_ENTITY_TYPES.includes(e.entity_type) || !e.entity_type
    );
    console.log(`🎯 Filtering for FNI: ${entities.length} models/agents (excluded ${allEntities.length - entities.length} papers/datasets)`);

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const results = [];
    const startTime = Date.now();

    // Process in batches
    for (let i = 0; i < entities.length; i += BATCH_SIZE) {
        const batch = entities.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE);

        console.log(`\n🔄 Processing batch ${batchNum + 1}/${Math.ceil(entities.length / BATCH_SIZE)}...`);

        const batchResults = batch.map(entity => {
            const { fni_score, fni_breakdown } = calculateFNI(entity);
            return {
                id: entity.id,
                entity_type: entity.entity_type,
                fni_score,
                fni_breakdown,
                // Include minimal fields for ranking
                name: entity.name,
                source: entity.source,
                primary_category: entity.primary_category
            };
        });

        results.push(...batchResults);

        // Save batch file
        const batchFile = path.join(outputDir, `fni_batch_${batchNum}.json`);
        fs.writeFileSync(batchFile, JSON.stringify(batchResults, null, 2));
        console.log(`   ✅ Saved: ${batchFile} (${batchResults.length} entities)`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ FNI computation complete: ${results.length} entities in ${elapsed}s`);

    // Save summary
    const summary = {
        total_entities: results.length,
        batches: Math.ceil(results.length / BATCH_SIZE),
        computed_at: new Date().toISOString(),
        elapsed_seconds: parseFloat(elapsed),
        top_10: results.sort((a, b) => b.fni_score - a.fni_score).slice(0, 10)
    };

    fs.writeFileSync(path.join(outputDir, 'fni_summary.json'), JSON.stringify(summary, null, 2));

    return summary;
}

// CLI execution
if (process.argv[1].includes('fni-compute')) {
    const inputFile = process.argv[2] || 'data/entities.json';
    const outputDir = process.argv[3] || 'data/computed';

    computeAllFNI(inputFile, outputDir)
        .then(summary => {
            console.log('\n📊 Summary:');
            console.log(`   Total: ${summary.total_entities}`);
            console.log(`   Batches: ${summary.batches}`);
            console.log(`   Time: ${summary.elapsed_seconds}s`);
        })
        .catch(err => {
            console.error('❌ Error:', err.message);
            process.exit(1);
        });
}

export default { computeAllFNI, calculateFNI };
