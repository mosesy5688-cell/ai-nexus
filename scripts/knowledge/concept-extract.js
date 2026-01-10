/**
 * Concept Extractor - V15.0
 * SPEC: SPEC-KNOWLEDGE-REPORT-V15.0
 * 
 * Extracts top concepts from entity tags and identifies new/unmapped concepts.
 */

// Existing knowledge articles (from knowledge-base-config.ts)
const EXISTING_ARTICLES = new Set([
    'mmlu', 'humaneval', 'hellaswag', 'arc',
    'context-length', 'parameters', 'transformer',
    'llama-family-guide', 'qwen-family-guide', 'mistral-family-guide',
    'gguf', 'ollama', 'run-locally',
    'fni', 'deploy-score',
    'moe', 'quantization', 'vram', 'local-inference',
    'rag', 'embeddings', 'multimodal', 'fine-tuning', 'agents'
]);

// Tag normalization mapping
const TAG_NORMALIZE = {
    'text-generation': 'text-generation',
    'text2text-generation': 'text-generation',
    'image-to-text': 'vision',
    'image-classification': 'vision',
    'object-detection': 'vision',
    'llama': 'llama-family',
    'llama2': 'llama-family',
    'llama3': 'llama-family',
    'qwen': 'qwen-family',
    'qwen2': 'qwen-family',
    'mistral': 'mistral-family',
};

/**
 * Extract concepts from entity tags
 * @param {Array} entities 
 * @returns {Array} Top concepts sorted by count
 */
export function extractConcepts(entities) {
    const tagCounts = new Map();

    for (const entity of entities) {
        const tags = entity.tags || [];
        const pipelineTag = entity.pipeline_tag;
        const allTags = pipelineTag ? [...tags, pipelineTag] : tags;

        for (let tag of allTags) {
            if (!tag || typeof tag !== 'string') continue;
            tag = tag.toLowerCase().trim();

            // Normalize
            const normalized = TAG_NORMALIZE[tag] || tag;

            // Skip very short or numeric tags
            if (normalized.length < 3 || /^\d+$/.test(normalized)) continue;

            tagCounts.set(normalized, (tagCounts.get(normalized) || 0) + 1);
        }
    }

    // Sort by count, take top 200
    const sorted = Array.from(tagCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 200);

    return sorted.map(([tag, count]) => ({
        slug: tag.replace(/[^a-z0-9-]/g, '-'),
        name: formatConceptName(tag),
        count,
        hasArticle: EXISTING_ARTICLES.has(tag.replace(/[^a-z0-9-]/g, '-'))
    }));
}

/**
 * Generate discovery report for new concepts
 */
export function getDiscoveryReport(entities, concepts) {
    const newConcepts = concepts
        .filter(c => !c.hasArticle && c.count >= 30)
        .slice(0, 10);

    const unmappedTags = concepts
        .filter(c => !c.hasArticle && c.count >= 20 && c.count < 30)
        .slice(0, 10);

    return {
        _ts: new Date().toISOString(),
        new_concepts: newConcepts.map(c => ({ tag: c.slug, count: c.count })),
        unmapped_tags: unmappedTags.map(c => ({ tag: c.slug, count: c.count })),
        recommendation: newConcepts.length > 0
            ? `Consider adding articles for: ${newConcepts.map(c => c.slug).join(', ')}`
            : 'No new high-frequency concepts detected'
    };
}

/**
 * Format tag to readable name
 */
function formatConceptName(tag) {
    return tag
        .split('-')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}
