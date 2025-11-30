// src/utils/frontend-data.js
/**
 * Frontend Data Coordination Layer
 * Ensures D1 database data is properly formatted for frontend display
 * DO NOT modify core data collection or processing modules
 */

/**
 * Normalize model data from D1 for consistent frontend display
 * @param {Object} rawModel - Raw model data from D1
 * @returns {Object} Normalized model data
 */
export function normalizeModelData(rawModel) {
    if (!rawModel || typeof rawModel !== 'object') {
        console.warn('Invalid model data received:', rawModel);
        return createPlaceholderModel();
    }

    return {
        // Core identifiers
        id: rawModel.id || 'unknown',
        name: rawModel.name || 'Untitled Model',
        author: rawModel.author || 'Unknown Author',

        // Metrics (ensure numbers)
        likes: parseInt(rawModel.likes) || 0,
        downloads: parseInt(rawModel.downloads) || 0,

        // Text content (ensure strings)
        description: ensureString(rawModel.description),
        seo_summary: ensureString(rawModel.seo_summary),

        // Status fields
        seo_status: rawModel.seo_status || 'pending',
        link_status: rawModel.link_status || 'unknown',

        // Metadata
        pipeline_tag: rawModel.pipeline_tag || '',
        license: rawModel.license || 'Unknown',
        last_updated: rawModel.last_updated || new Date().toISOString(),
        slug: rawModel.slug || generateSlug(rawModel.id), // Use DB slug or fallback

        // Image handling
        cover_image_url: validateImageUrl(rawModel.cover_image_url),

        // Parse JSON fields safely
        tags: parseJSONField(rawModel.tags, []),
        links_data: parseJSONField(rawModel.links_data, {}),
        related_ids: parseJSONField(rawModel.related_ids, []),

        // Preserve raw data for debugging
        _raw: rawModel
    };
}

/**
 * Create placeholder model for missing/error cases
 */
function createPlaceholderModel() {
    return {
        id: 'placeholder',
        name: 'Model Unavailable',
        author: 'Unknown',
        likes: 0,
        downloads: 0,
        description: 'This model information is currently unavailable. Please try again later.',
        seo_summary: '',
        seo_status: 'pending',
        link_status: 'unknown',
        pipeline_tag: '',
        license: 'Unknown',
        last_updated: new Date().toISOString(),
        cover_image_url: '/placeholder-model.png',
        tags: [],
        links_data: {},
        related_ids: [],
        _isPlaceholder: true
    };
}

/**
 * Ensure value is a string
 */
function ensureString(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
        // Handle [object Object] case
        try {
            return JSON.stringify(value);
        } catch (e) {
            return String(value);
        }
    }
    return String(value);
}

/**
 * Validate and sanitize image URLs
 */
function validateImageUrl(url) {
    if (!url || typeof url !== 'string') return '/placeholder-model.png';

    // Check if URL is valid
    try {
        new URL(url);
        return url;
    } catch (e) {
        // If not absolute URL, check if it's a relative path
        if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) return url;
        return '/placeholder-model.png';
    }
}

/**
 * Safely parse JSON fields
 */
function parseJSONField(value, fallback) {
    if (!value) return fallback;
    if (typeof value !== 'string') return value; // Already parsed

    try {
        return JSON.parse(value);
    } catch (e) {
        console.warn('Failed to parse JSON field:', value);
        return fallback;
    }
}

/**
 * Format metrics for display
 */
export function formatMetric(num) {
    if (typeof num !== 'number') num = parseInt(num) || 0;
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
}

/**
 * Format relative time
 */
export function formatRelativeTime(dateString) {
    if (!dateString) return 'Unknown';

    try {
        const date = new Date(dateString);
        if (isNaN(date.getTime())) return 'Unknown';
        const now = new Date();
        const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

        if (diffInSeconds < 60) return 'just now';
        if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
        if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`;
        if (diffInSeconds < 2592000) return `${Math.floor(diffInSeconds / 86400)}d ago`;
        if (diffInSeconds < 31536000) return `${Math.floor(diffInSeconds / 2592000)}mo ago`;
        return `${Math.floor(diffInSeconds / 31536000)}y ago`;
    } catch (e) {
        return 'Unknown';
    }
}

/**
 * Validate model data completeness
 * Returns array of missing/invalid fields
 */
export function validateModelData(model) {
    const issues = [];

    if (!model.id || model.id === 'unknown') issues.push('missing_id');
    if (!model.name || model.name === 'Untitled Model') issues.push('missing_name');
    if (!model.author || model.author === 'Unknown Author') issues.push('missing_author');
    if (typeof model.description !== 'string') issues.push('invalid_description');
    if (typeof model.likes !== 'number') issues.push('invalid_likes');
    if (typeof model.downloads !== 'number') issues.push('invalid_downloads');

    return issues;
}

/**
 * Generate SEO-friendly slug from model ID
 */
export function generateSlug(modelId) {
    if (!modelId || typeof modelId !== 'string') return 'unknown';
    return modelId.replace(/\//g, '--');
}

/**
 * Parse slug back to model ID
 */
export function parseSlug(slug) {
    if (!slug || typeof slug !== 'string') return '';
    return slug.replace(/--/g, '/');
}

/**
 * Extract display name from model 
 */
export function getDisplayName(model) {
    if (!model) return 'Unknown Model';
    return model.name || model.id || 'Untitled';
}

/**
 * Get best description (SEO summary > description > fallback)
 */
export function getBestDescription(model) {
    if (!model) return 'No description available.';

    // Prefer SEO summary if available and done
    if (model.seo_status === 'done' && model.seo_summary) {
        return model.seo_summary;
    }

    // Fallback to regular description
    if (model.description) {
        const desc = ensureString(model.description);
        // Clean HTML tags
        return desc.replace(/<[^>]*>/g, '');
    }

    return 'No description available.';
}

/**
 * Prepare model data for card display
 */
export function prepareCardData(model) {
    const normalized = normalizeModelData(model);
    return {
        id: normalized.id,
        name: getDisplayName(normalized),
        author: normalized.author,
        description: getBestDescription(normalized).substring(0, 150) + '...',
        likes: normalized.likes,
        downloads: normalized.downloads,
        cover_image_url: normalized.cover_image_url,
        url: `/model/${normalized.slug || generateSlug(normalized.id)}`,
        pipeline_tag: normalized.pipeline_tag,
        last_updated: formatRelativeTime(normalized.last_updated)
    };
}

/**
 * Prepare model data for detail page
 */
export function findSimilarModels(targetModel, allModels, count = 5) {
    if (!targetModel || !allModels || !Array.isArray(allModels)) return [];

    const targetTags = new Set(targetModel.tags || []);

    return allModels
        .filter(model => model.id !== targetModel.id)
        .map(model => {
            let modelTags = model.tags || [];
            // Handle raw DB data where tags is a JSON string
            if (typeof modelTags === 'string') {
                try {
                    modelTags = JSON.parse(modelTags);
                } catch (e) {
                    modelTags = [];
                }
            }
            // Ensure it's an array
            if (!Array.isArray(modelTags)) modelTags = [];

            const sharedTags = modelTags.filter(tag => targetTags.has(tag));
            return { model, score: sharedTags.length };
        })
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, count)
        .map(item => item.model);
}

export function prepareDetailData(model, allModels = []) {
    const normalized = normalizeModelData(model);
    const validation = validateModelData(normalized);
    const similarModels = findSimilarModels(normalized, allModels, 5);

    return {
        ...normalized,
        displayName: getDisplayName(normalized),
        displayDescription: getBestDescription(normalized),
        formattedLikes: formatMetric(normalized.likes),
        formattedDownloads: formatMetric(normalized.downloads),
        relativeTime: formatRelativeTime(normalized.last_updated),
        similarModels,
        validation,
        hasIssues: validation.length > 0
    };
}

/**
 * Log data coordination activity
 */
export function logDataActivity(action, data, error = null) {
    const log = {
        timestamp: new Date().toISOString(),
        action,
        data,
        error
    };

    console.log('[Frontend Data Coordination]', log);

    // Store in session for debugging (optional)
    if (typeof window !== 'undefined') {
        try {
            const logs = JSON.parse(sessionStorage.getItem('frontend_data_logs') || '[]');
            logs.push(log);
            // Keep only last 50 logs
            if (logs.length > 50) logs.shift();
            sessionStorage.setItem('frontend_data_logs', JSON.stringify(logs));
        } catch (e) {
            // Ignore storage errors
        }
    }

    return log;
}
