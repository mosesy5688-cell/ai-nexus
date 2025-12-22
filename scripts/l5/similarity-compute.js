/**
 * L5 Similarity Compute Script
 * 
 * B.14 Smart Recommend
 * Pre-computes similar models based on heuristic scoring.
 * 
 * @module l5/similarity-compute
 */

import fs from 'fs';
import path from 'path';

/**
 * Calculate similarity score between two entities
 * @returns {number} Score (higher is more similar)
 */
function calculateSimilarity(a, b) {
    let score = 0;

    // 1. Category Match (Required Base)
    if (a.primary_category !== b.primary_category) return 0;
    score += 10;

    // 2. Base Model Match (+50)
    // Looking at meta_json.base_model or name prefix
    const baseA = a.meta_json?.base_model || (a.name?.split('-')[0]);
    const baseB = b.meta_json?.base_model || (b.name?.split('-')[0]);
    if (baseA && baseB && baseA.toLowerCase() === baseB.toLowerCase()) {
        score += 50;
    }

    // 3. Scale Similarity (+30)
    // Match 7B with 7B, 70B with 70B
    const paramsA = a.meta_json?.params;
    const paramsB = b.meta_json?.params;
    if (paramsA && paramsB && paramsA === paramsB) {
        score += 30;
    }

    // 4. Tags Overlap (+5 per tag, max 30)
    const tagsA = new Set(a.tags || []);
    const tagsB = b.tags || [];
    let tagMatch = 0;
    for (const tag of tagsB) {
        if (tagsA.has(tag)) tagMatch += 5;
    }
    score += Math.min(30, tagMatch);

    // 5. FNI Boost
    score += (b.fni_score || 0) / 10;

    return score;
}

/**
 * Compute similar models for all entities
 */
export async function computeSimilarity(entitiesFile, outputFile) {
    console.log(`🧠 Computing similarity for entities in ${entitiesFile}...`);
    const entities = JSON.parse(fs.readFileSync(entitiesFile, 'utf8'));

    // Group by category to optimize (only compare within same category)
    const byCategory = {};
    for (const entity of entities) {
        const cat = entity.primary_category || 'uncategorized';
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(entity);
    }

    const startTime = Date.now();
    let updatedCount = 0;

    // Process each category
    for (const [cat, catEntities] of Object.entries(byCategory)) {
        if (catEntities.length < 2) continue;
        console.log(`   Processing ${cat}: ${catEntities.length} entities`);

        for (const target of catEntities) {
            // Ensure meta_json is an object
            if (typeof target.meta_json === 'string' && target.meta_json.startsWith('{')) {
                try {
                    target.meta_json = JSON.parse(target.meta_json);
                } catch (e) {
                    target.meta_json = {};
                }
            } else if (!target.meta_json || typeof target.meta_json !== 'object') {
                target.meta_json = {};
            }

            const scores = [];
            for (const candidate of catEntities) {
                if (target.id === candidate.id) continue;

                // Ensure candidate meta_json is also an object for comparison
                // Note: The calculateSimilarity function expects the meta_json to be part of the 'b' object.
                // We are temporarily parsing it here for the comparison logic.
                let candidateMeta = candidate.meta_json;
                if (typeof candidateMeta === 'string' && candidateMeta.startsWith('{')) {
                    try { candidateMeta = JSON.parse(candidateMeta); } catch (e) { candidateMeta = {}; }
                }
                // Create a temporary candidate object with parsed meta_json for calculateSimilarity
                const tempCandidate = { ...candidate, meta_json: candidateMeta };

                const score = calculateSimilarity(target, tempCandidate);
                if (score > 15) {
                    scores.push({ id: candidate.id, score });
                }
            }

            // Sort by score and take top 5
            const similar = scores
                .sort((a, b) => b.score - a.score)
                .slice(0, 5)
                .map(s => s.id);

            if (similar.length > 0) {
                target.meta_json.similar_models = similar;
                updatedCount++;
            }
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ Computed similarity for ${updatedCount} entities in ${elapsed}s`);

    // Save updated entities
    fs.writeFileSync(outputFile, JSON.stringify(entities, null, 2));
    console.log(`💾 Saved updated entities to: ${outputFile}`);

    return updatedCount;
}

// CLI execution
if (process.argv[1].includes('similarity-compute')) {
    const inputFile = process.argv[2] || 'data/entities.json';
    const outputFile = process.argv[3] || 'data/entities.json';

    computeSimilarity(inputFile, outputFile)
        .catch(err => {
            console.error('❌ Error:', err.message);
            process.exit(1);
        });
}
