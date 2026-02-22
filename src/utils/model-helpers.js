
// src/utils/model-helpers.js
// Business logic for model entities
// Extracted from data-service.js for CES V5.1.2 Compliance

import { ensureString, parseJSONField, validateUrl, validateImageUrl } from './formatters.js';

export function generateSlug(modelId) {
    if (!modelId) return '';
    return modelId.replace(/\//g, '--');
}

export function parseSlug(slug) {
    if (!slug) return '';
    return slug.replace(/--/g, '/');
}

export function getDisplayName(model) {
    return model.name || model.id || 'Unknown Model';
}

export function cleanupDescription(text) {
    if (!text) return '';
    // V21.15.6: Robust YAML frontmatter stripping (handles leading whitespace/newlines)
    let processedContent = text.replace(/^[\s\n]*---\s*[\s\S]*?---\s*\n?/g, '');
    // Remove HTML tags
    const noHtml = processedContent.replace(/<[^>]*>?/gm, '');
    return noHtml.trim();
}

export function getBestDescription(model) {
    if (model.seo_summary && model.seo_summary.description) {
        return cleanupDescription(model.seo_summary.description);
    }
    if (model.description) {
        return cleanupDescription(model.description);
    }
    return 'No description available for this model.';
}

export function prepareCardData(model) {
    return {
        id: model.id,
        slug: model.slug || generateSlug(model.id),
        name: getDisplayName(model),
        description: getBestDescription(model),
        downloads: model.downloads || 0,
        likes: model.likes || 0,
        tags: parseJSONField(model.tags, []).slice(0, 3), // Limit tags for card
        author: model.author || 'Unknown',
        last_modified: model.last_modified
    };
}

export function prepareDetailData(rawModel, candidateModels = []) {
    if (!rawModel) return null;

    const processed = {
        ...rawModel,
        slug: rawModel.slug || generateSlug(rawModel.id),
        displayName: getDisplayName(rawModel),
        cleanDescription: getBestDescription(rawModel),
        tags: parseJSONField(rawModel.tags, []),
        siblings: candidateModels.filter(m => m.id !== rawModel.id).slice(0, 5) // Simplified siblings logic
    };
    return processed;
}

export function findSimilarModels(targetModel, allModels, count = 5) {
    if (!targetModel || !allModels) return [];

    const targetTags = new Set(parseJSONField(targetModel.tags, []));

    return allModels
        .filter(m => m.id !== targetModel.id)
        .map(m => {
            const mTags = parseJSONField(m.tags, []);
            const intersection = mTags.filter(t => targetTags.has(t));
            return { model: m, score: intersection.length };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, count)
        .map(item => item.model);
}
