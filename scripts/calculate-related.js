/**
 * Helios V3.0 - Related Models Calculator
 * Algorithm: Inverted Index
 * Complexity: O(N) - Significantly better than O(N^2) nested loops
 */

function calculateRelatedModels(models) {
    console.log(`- [Module] Calculating related models for ${models.length} items using Inverted Index...`);
    const startTime = Date.now();

    // 1. Build Inverted Index (Tag -> [Model IDs])
    const tagMap = new Map();

    models.forEach(model => {
        let tags = [];
        try {
            // Compatibility: might be JSON string or already an array
            tags = typeof model.tags === 'string' ? JSON.parse(model.tags) : model.tags;
        } catch (e) { tags = []; }

        if (Array.isArray(tags)) {
            tags.forEach(tag => {
                if (!tagMap.has(tag)) tagMap.set(tag, []);
                // Store only ID and Likes to reduce memory usage, avoid storing entire model object
                tagMap.get(tag).push({ id: model.id, likes: model.likes || 0 });
            });
        }
    });

    // 2. Fast Lookup & Scoring
    let processedCount = 0;
    models.forEach(model => {
        let tags = [];
        try { tags = typeof model.tags === 'string' ? JSON.parse(model.tags) : model.tags; } catch (e) { }

        if (!Array.isArray(tags) || tags.length === 0) {
            model.related_ids = JSON.stringify([]);
            return;
        }

        const candidates = new Map(); // Use Map to automatically deduplicate IDs

        // Iterate through all tags of the current model
        tags.forEach((tag, index) => {
            const siblings = tagMap.get(tag) || [];
            siblings.forEach(sibling => {
                if (sibling.id === model.id) return; // Exclude self

                if (!candidates.has(sibling.id)) {
                    // Scoring Algorithm: 
                    // Base score = Likes
                    // Weight bonus = If it's the first tag (usually primary category), add 1000 points
                    let score = sibling.likes;
                    if (index === 0) score += 1000;

                    candidates.set(sibling.id, { id: sibling.id, score: score });
                }
            });
        });

        // Take Top 3, sorted by score descending
        const top3 = Array.from(candidates.values())
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
            .map(item => item.id);

        model.related_ids = JSON.stringify(top3);
        processedCount++;
    });

    const duration = (Date.now() - startTime) / 1000;
    console.log(`✅ [Module] Related models calculated for ${processedCount} items in ${duration.toFixed(3)}s.`);

    return models;
}

// Export function for main script (ES Module format)
export { calculateRelatedModels };
