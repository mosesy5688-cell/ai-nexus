
// src/utils/data-service.js
// Frontend Data Coordination Layer (Refactored V5.1.2)
// Facade for formatters and model helpers.

import {
    ensureString,
    validateImageUrl,
    validateUrl,
    parseJSONField,
    formatMetric,
    formatRelativeTime,
    createPlaceholderModel,
    validateModelData,
    normalizeModelData
} from './formatters.js';

import {
    generateSlug,
    parseSlug,
    getDisplayName,
    getBestDescription,
    cleanupDescription,
    prepareCardData,
    prepareDetailData,
    findSimilarModels
} from './model-helpers.js';

// Re-export everything for backward compatibility
export {
    ensureString,
    validateImageUrl,
    validateUrl,
    parseJSONField,
    formatMetric,
    formatRelativeTime,
    createPlaceholderModel,
    validateModelData,
    normalizeModelData,
    generateSlug,
    parseSlug,
    getDisplayName,
    getBestDescription,
    cleanupDescription,
    prepareCardData,
    prepareDetailData,
    findSimilarModels
};

// Log data coordination activity
export function logDataActivity(action, data, error = null) {
    if (import.meta.env.DEV) {
        const timestamp = new Date().toISOString();
        const style = error ? 'color: red' : 'color: blue';
        console.groupCollapsed(`%c[DataService] ${action} @ ${timestamp}`, style);
        console.log('Payload:', data);
        if (error) console.error('Error:', error);
        console.groupEnd();
    }
}
