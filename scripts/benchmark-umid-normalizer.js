/**
 * Benchmark UMID Normalizer V4.4
 * 
 * Constitution V4.3.2 Compliant: Auto-canonicalizes benchmark UMIDs 
 * to match D1 models canonical_name format.
 * 
 * Converts: qwen-qwen2-5-72b → qwen-qwen2-5-72b-instruct (matchable)
 * 
 * Usage:
 *   import { normalizeBenchmarkUMID, generateCanonicalVariants } from './benchmark-umid-normalizer.js';
 */

/**
 * Normalize a benchmark UMID to canonical format
 * @param {string} benchUMID - The benchmark UMID (e.g., "qwen-qwen2-5-72b")
 * @returns {string} Normalized UMID
 */
export function normalizeBenchmarkUMID(benchUMID) {
    if (!benchUMID) return '';

    let s = benchUMID.toLowerCase();

    // Unify separators
    s = s.replace(/[_\.]/g, '-');

    // Collapse multiple dashes
    s = s.replace(/-+/g, '-');

    // Remove trailing dashes
    s = s.replace(/^-|-$/g, '');

    // Remove common suffixes for matching
    s = s
        .replace(/-instruct$/, '')
        .replace(/-chat$/, '')
        .replace(/-base$/, '');

    return s;
}

/**
 * Generate multiple canonical name variants for fuzzy matching
 * @param {string} benchUMID - The benchmark UMID
 * @returns {string[]} Array of possible canonical name variants
 */
export function generateCanonicalVariants(benchUMID) {
    if (!benchUMID) return [];

    const base = normalizeBenchmarkUMID(benchUMID);
    const variants = new Set([base]);

    // Add with common suffixes
    variants.add(`${base}-instruct`);
    variants.add(`${base}-chat`);
    variants.add(`${base}-base`);

    // Handle version numbers (2-5 → 2.5)
    const withDot = base.replace(/-(\d+)-(\d+)([^-]*)$/, '-$1.$2$3');
    if (withDot !== base) {
        variants.add(withDot);
        variants.add(`${withDot}-instruct`);
    }

    // Handle family prefixes
    const familyMappings = {
        'qwen-': '',
        'meta-llama-': '',
        'llama-': 'meta-llama-',
        'mistralai-': '',
        'mistral-': 'mistralai-',
        'deepseek-ai-': '',
        'deepseek-': 'deepseek-ai-',
        'google-': '',
        'gemma-': 'google-',
        'microsoft-': '',
        'phi-': 'microsoft-'
    };

    for (const [prefix, replacement] of Object.entries(familyMappings)) {
        if (base.startsWith(prefix) && replacement) {
            const variant = replacement + base.slice(prefix.length);
            variants.add(variant);
            variants.add(`${variant}-instruct`);
        }
    }

    return Array.from(variants);
}

/**
 * Convert benchmark name to D1-style canonical_name format
 * D1 canonical_name: lowercase, hyphens, from model name
 * @param {string} hfName - HuggingFace model name (e.g., "Qwen/Qwen2.5-72B-Instruct")
 * @returns {string} D1-style canonical name
 */
export function hfNameToCanonical(hfName) {
    if (!hfName) return '';

    return hfName
        .toLowerCase()
        .replace(/\//g, '-')
        .replace(/\s+/g, '-')
        .replace(/\./g, '-')
        .replace(/_/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

/**
 * Try to match a benchmark record to D1 models
 * @param {object} benchmark - Benchmark record with umid and name fields
 * @param {Map} canonicalMap - Map of canonical_name → model
 * @param {Map} idMap - Map of id → model
 * @returns {object|null} Matched model or null
 */
export function tryMatchBenchmark(benchmark, canonicalMap, idMap) {
    // First try: direct HuggingFace name match (converted to canonical)
    const hfCanonical = hfNameToCanonical(benchmark.name);
    if (canonicalMap.has(hfCanonical)) {
        return { model: canonicalMap.get(hfCanonical), method: 'hf_canonical', confidence: 1.0 };
    }

    // Second try: generate variants from benchmark.umid
    const variants = generateCanonicalVariants(benchmark.umid);
    for (const variant of variants) {
        if (canonicalMap.has(variant)) {
            return { model: canonicalMap.get(variant), method: 'variant_canonical', confidence: 0.95 };
        }
    }

    // Third try: ID lookup with HF name
    const hfId = benchmark.name; // Usually in format "Qwen/Qwen2.5-72B-Instruct"
    if (idMap.has(hfId)) {
        return { model: idMap.get(hfId), method: 'hf_id', confidence: 1.0 };
    }

    // Fourth try: Partial matching on name keywords
    const keywords = benchmark.umid.split('-').filter(k => k.length > 2);
    for (const [canonical, model] of canonicalMap.entries()) {
        const matchCount = keywords.filter(k => canonical.includes(k)).length;
        if (matchCount >= keywords.length * 0.7) {
            return { model, method: 'keyword_match', confidence: 0.8 };
        }
    }

    return null;
}
