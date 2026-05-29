// src/utils/benchmark-labels.js
// Centralized schema reflection engine for evaluation metrics (V27.88).
// Single source of truth for benchmark display names. Frontend iterates the
// benchmarks blob generically so upstream schema drift never silently zeroes
// the UI (the v1->v2 column mismatch that this replaces).
export const BENCHMARK_LABEL_MAP = {
    average: 'Leaderboard Average',
    ifeval: 'Instruction Following (IFEval)',
    bbh: 'Core Reasoning (BBH)',
    math_lvl5: 'Advanced Math (MATH Lvl 5)',
    gpqa: 'Graduate QA (GPQA)',
    musr: 'Multistep Reasoning (MuSR)',
    mmlu_pro: 'MMLU-Pro',
};

/**
 * Humanizes raw snake_case keys as a safety net against upstream drift.
 * @param {string} key
 * @returns {string}
 */
export function prettify(key) {
    return String(key)
        .replace(/[_-]/g, ' ')
        .trim()
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Transforms a raw pass-through benchmark blob into normalized display rows.
 * Keeps only finite-number values (drops non-score keys like `name`/`__schema`).
 * Unknown numeric keys fall back to a humanized label -- never suppressed.
 * @param {Record<string, any>} benchmarks
 * @returns {Array<{key: string, value: number, label: string}>}
 */
export function toMetricRows(benchmarks) {
    if (!benchmarks || typeof benchmarks !== 'object') return [];
    return Object.entries(benchmarks)
        .filter(([key, val]) => key !== '__schema' && typeof val === 'number' && Number.isFinite(val))
        .map(([key, val]) => ({
            key,
            value: val,
            label: BENCHMARK_LABEL_MAP[key] || prettify(key),
        }));
}
