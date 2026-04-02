
// src/utils/builders/model-getters.js
import { safeParseJSON, safeString, safeNumber } from './parsing-utils.js';

// Get display name from model
export function getDisplayName(model) {
    return safeString(model.name) || safeString(model.id) || 'Unknown Model';
}

// Get best description for display
export function getBestDescription(model) {
    const desc = safeString(model.description) || safeString(model.readme);
    // Clean up [object Object] artifacts if they slipped through DB
    if (desc.includes('[object Object]')) return '';
    return desc;
}

// Parse benchmarks with fallbacks
export function parseBenchmarks(model) {
    return {
        mmlu: safeNumber(model.mmlu || model.benchmark_mmlu),
        hellaswag: safeNumber(model.hellaswag || model.benchmark_hellaswag),
        arc: safeNumber(model.arc_challenge || model.benchmark_arc),
        humaneval: safeNumber(model.humaneval || model.benchmark_humaneval),
        avg_score: safeNumber(model.avg_score || model.benchmark_avg)
    };
}

// Parse specs with fallbacks
export function parseSpecs(model) {
    return {
        velocity_score: safeNumber(model.velocity_score),
        params_billions: safeNumber(model.params_billions),
        context_length: safeString(model.context_length),
        license_spdx: safeString(model.license_spdx),
        has_gguf: Boolean(model.has_gguf),
        has_ollama: Boolean(model.has_ollama),
        ollama_pulls: safeNumber(model.ollama_pulls),
        gguf_variants: safeParseJSON(model.gguf_variants, [])
    };
}

// Build FNI data with fallbacks
export function buildFNI(model) {
    return {
        fni_score: safeNumber(model.fni_score ?? model.fni),
        fni_semantic: safeNumber(model.fni_semantic ?? model.fni_s ?? 50),
        fni_authority: safeNumber(model.fni_authority ?? model.fni_a),
        fni_popularity: safeNumber(model.fni_popularity ?? model.fni_p),
        fni_recency: safeNumber(model.fni_recency ?? model.fni_r),
        fni_quality: safeNumber(model.fni_quality ?? model.fni_q)
    };
}
