
// src/utils/formatters.js
// Utility functions for formatting and validating model data
// Extracted from data-service.js for CES V5.1.2 Compliance

export function ensureString(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch (e) {
            return String(value);
        }
    }
    return String(value);
}

export function validateImageUrl(url) {
    if (!url) return '/images/models/default-model.jpg'; // Verify path existence?
    if (typeof url !== 'string') return '/images/models/default-model.jpg';
    if (url.match(/\.(jpeg|jpg|gif|png|webp)$/) != null) return url;
    return url; // Return as is if no extension but non-empty
}

export function validateUrl(url, fallback = '#') {
    if (!url) return fallback;
    try {
        new URL(url);
        return url;
    } catch (e) {
        return fallback;
    }
}

export function parseJSONField(value, fallback) {
    if (!value) return fallback;
    if (Array.isArray(value)) return value;
    if (typeof value === 'object') return value; // Already object/proxy

    try {
        return JSON.parse(value);
    } catch (e) {
        // Warning: Safe parsing failure
        return fallback;
    }
}

export function formatMetric(num) {
    if (num === undefined || num === null) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toLocaleString();
}

export function formatRelativeTime(dateString) {
    if (!dateString) return 'Unknown';
    try {
        const date = new Date(dateString);
        const now = new Date();
        const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

        const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

        if (diffInSeconds < 60) return rtf.format(-diffInSeconds, 'second');
        if (diffInSeconds < 3600) return rtf.format(-Math.floor(diffInSeconds / 60), 'minute');
        if (diffInSeconds < 86400) return rtf.format(-Math.floor(diffInSeconds / 3600), 'hour');
        if (diffInSeconds < 2592000) return rtf.format(-Math.floor(diffInSeconds / 86400), 'day');
        if (diffInSeconds < 31536000) return rtf.format(-Math.floor(diffInSeconds / 2592000), 'month');
        return rtf.format(-Math.floor(diffInSeconds / 31536000), 'year');
    } catch (e) {
        return 'Unknown';
    }
}

export function createPlaceholderModel() {
    return {
        id: 'placeholder-' + Math.random().toString(36).substr(2, 9),
        name: 'Loading...',
        description: 'Please wait while we fetch the latest model data.',
        downloads: 0,
        likes: 0,
        tags: [],
        last_modified: new Date().toISOString()
    };
}

export function validateModelData(model) {
    const missing = [];
    if (!model.id) missing.push('id');
    if (!model.name) missing.push('name');
    // if (!model.author) missing.push('author'); // Optional?
    return missing;
}

export function normalizeModelData(rawModel) {
    if (!rawModel) return createPlaceholderModel();

    return {
        ...rawModel,
        downloads: typeof rawModel.downloads === 'number' ? rawModel.downloads : 0,
        likes: typeof rawModel.likes === 'number' ? rawModel.likes : 0,
        tags: parseJSONField(rawModel.tags, []),
        last_modified: rawModel.last_modified || new Date().toISOString(),
        // Add other normalization rules here
    };
}
