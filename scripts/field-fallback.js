#!/usr/bin/env node
/**
 * Field Fallback Manager - V4 Stable Execution Layer
 * Constitution V4.3.2 Compliant
 * 
 * A3: Ensures core fields never show N/A
 */

// Centralized fallback defaults
const FIELD_DEFAULTS = {
    params_billions: 7.0,
    context_length: 8192,
    architecture_family: 'transformer',
    deploy_score: 0.2,
    has_benchmarks: false
};

// Architecture family patterns
const ARCHITECTURE_PATTERNS = {
    'llama': /llama/i,
    'qwen': /qwen/i,
    'mistral': /mistral/i,
    'gemma': /gemma/i,
    'phi': /phi/i,
    'deepseek': /deepseek/i,
    'gpt': /gpt/i,
    'falcon': /falcon/i,
    'bloom': /bloom/i,
    'mpt': /mpt/i
};

/**
 * Extract params from model name (e.g., "Llama-3-70B" → 70.0)
 * @param {string} name - Model name
 * @returns {number|null} - Extracted size or null
 */
function extractParamsFromName(name) {
    if (!name) return null;
    const match = name.match(/(\d+\.?\d*)\s*[Bb]/);
    return match ? parseFloat(match[1]) : null;
}

/**
 * Infer architecture family from model name
 * @param {string} name - Model name
 * @returns {string} - Architecture family
 */
function inferArchitectureFamily(name) {
    if (!name) return FIELD_DEFAULTS.architecture_family;

    for (const [family, pattern] of Object.entries(ARCHITECTURE_PATTERNS)) {
        if (pattern.test(name)) return family;
    }
    return FIELD_DEFAULTS.architecture_family;
}

/**
 * Apply fallbacks to ensure no N/A fields
 * @param {Object} model - Model object
 * @returns {Object} - Model with fallbacks applied
 */
function applyFallbacks(model) {
    const result = { ...model };

    // Extract params if missing
    if (!result.params_billions) {
        result.params_billions = extractParamsFromName(result.name) || FIELD_DEFAULTS.params_billions;
    }

    // Infer architecture if missing
    if (!result.architecture_family) {
        result.architecture_family = inferArchitectureFamily(result.name);
    }

    // Apply remaining defaults
    for (const [field, defaultVal] of Object.entries(FIELD_DEFAULTS)) {
        if (result[field] === null || result[field] === undefined) {
            result[field] = defaultVal;
        }
    }

    return result;
}

export {
    FIELD_DEFAULTS,
    extractParamsFromName,
    inferArchitectureFamily,
    applyFallbacks
};
