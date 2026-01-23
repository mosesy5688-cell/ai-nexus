
// src/utils/builders/parsing-utils.js

// Safely parse JSON with fallback
export function safeParseJSON(value, fallback = null) {
    if (typeof value === 'object' && value !== null) return value;
    try {
        return JSON.parse(value);
    } catch (e) {
        return fallback;
    }
}

// Safely get string with fallback
export function safeString(value, fallback = '') {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string') return value;
    // Handle objects that shouldn't be strings (like [object Object])
    if (typeof value === 'object') {
        // Try to stringify if it looks like data, else empty
        try {
            return JSON.stringify(value);
        } catch {
            return fallback;
        }
    }
    return String(value);
}

// Safely get number with fallback
export function safeNumber(value, fallback = 0) {
    const num = Number(value);
    return isNaN(num) ? fallback : num;
}

// Truncate text to max length (Zero-Limit: high ceiling for previews)
export function truncate(text, maxLength = 1000) {
    if (!text) return '';
    const str = safeString(text);
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '...';
}
