import { fetchAllModelsFromD1, updateD1 } from './post-processing/pp-db.js';
import {
    assignTagsAndStandardize,
    generateKeywords,
    calculateScoresAndRisingStars,
    calculateRelatedModels
} from './post-processing/pp-processors.js';
import { generateRankings, createSearchIndex } from './post-processing/pp-output.js';

// --- Main Execution ---

async function main() {
    console.log('🚀 Starting Loop 3: Post-processing...');

    // 1. Fetch
    let models = fetchAllModelsFromD1();
    console.log(`📥 Fetched ${models.length} models from D1.`);

    // 2. Standardize Tags
    models = assignTagsAndStandardize(models);

    // 3. Generate Keywords
    generateKeywords(models);

    // 4. Scoring
    models = calculateScoresAndRisingStars(models);

    // 5. Relationships
    models = calculateRelatedModels(models);

    // 6. Rankings
    generateRankings(models);

    // 7. Search Index
    createSearchIndex(models);

    // 8. Update D1 (Optional but recommended to keep DB in sync with JSONs)
    // The user requirement says "Save all processed data... to public/data directory".
    // It implies the JSONs are the consumption point for the frontend.
    // However, updating D1 is good practice for persistence.
    await updateD1(models);

    console.log('✅ Loop 3 completed successfully.');
}

main();
