
// UI Utilities (Shared Frontend Logic)

export function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num != null ? num.toLocaleString() : 0;
}

import { EntityCardRenderer } from './lib/EntityCardRenderer.js';

/**
 * Legacy Wrapper for createModelCardHTML
 * Always delegate to EntityCardRenderer to ensure absolute visual parity
 */
export function createModelCardHTML(model, type = 'model') {
    return EntityCardRenderer.createCardHTML(model, type);
}
