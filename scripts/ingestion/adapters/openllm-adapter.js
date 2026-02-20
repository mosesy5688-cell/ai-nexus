/**
 * Open LLM Leaderboard Adapter
 * V4.3.2 Constitution Compliance
 * 
 * Fetches benchmark scores from HuggingFace Open LLM Leaderboard
 * Source: https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard
 * 
 * @module ingestion/adapters/openllm-adapter
 */

import { BaseAdapter, NSFW_KEYWORDS } from './base-adapter.js';

// Open LLM Leaderboard datasets on HuggingFace
const LEADERBOARD_RESULTS_DATASET = 'open-llm-leaderboard/results';
const LEADERBOARD_TREE_API = 'https://huggingface.co/api/datasets/open-llm-leaderboard/results/tree/main';
const LEADERBOARD_RAW_BASE = 'https://huggingface.co/datasets/open-llm-leaderboard/results/resolve/main';

// Benchmark score columns
const BENCHMARK_COLUMNS = [
    'MMLU', 'ARC', 'HellaSwag', 'TruthfulQA', 'Winogrande', 'GSM8K'
];

export class OpenLLMLeaderboardAdapter extends BaseAdapter {
    constructor() {
        super('open_llm_leaderboard');
    }

    /**
     * Rate limiting delay helper - V4.3.2 Constitution
     * @param {number} ms - Milliseconds to delay
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Fetch benchmark data from Open LLM Leaderboard
     * V4.3.2: Uses HF Hub API as primary source (Constitution compliant)
     * @param {Object} options
     * @param {number} options.limit - Maximum records to fetch
     */
    async fetch(options = {}) {
        const { limit = 500 } = options;

        console.log(`📥 [OpenLLM] Fetching benchmark data (limit: ${limit})...`);

        try {
            // V4.3.2: Primary strategy - HF Hub API for models with evaluations
            // Filter for LLM models that typically have benchmark scores
            const hubUrl = `https://huggingface.co/api/models?` +
                `sort=downloads&direction=-1&limit=${Math.min(limit, 100)}` +
                `&filter=text-generation&full=true`;

            console.log(`   Fetching from HuggingFace Hub API...`);

            const response = await fetch(hubUrl, {
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Free2AITools/1.0'
                }
            });

            if (!response.ok) {
                console.warn(`   ⚠️ Hub API returned ${response.status}`);
                return this.getEmptyFallback();
            }

            const models = await response.json();
            console.log(`   📦 Got ${models.length} text-generation models`);

            // Extract evaluation metrics from official results dataset
            const benchmarks = [];
            for (const model of models.slice(0, limit)) {
                // 1. Identification
                const [author, modelId] = model.id.split('/');
                if (!author || !modelId) continue;

                // 2. Authoritative Fetch (V4.3.3 Root-Cause Fix)
                const benchmark = await this.fetchAuthoritativeBenchmark(author, modelId);

                if (benchmark) {
                    benchmarks.push(benchmark);
                } else {
                    // Fallback to legacy card extraction if dataset entry missing
                    const legacyBench = await this.extractBenchmarksFromModel(model);
                    if (legacyBench) benchmarks.push(legacyBench);
                }

                // Rate limiting - V4.3.2 Constitution
                if (benchmarks.length < limit) {
                    await this.delay(300); // Respect HF Hub
                }
            }

            console.log(`   ✅ Extracted ${benchmarks.length} benchmark records`);

            // Apply quality gate
            const validBenchmarks = benchmarks.filter(b => b.quality_flag === 'ok');
            console.log(`   🛡️ ${validBenchmarks.length}/${benchmarks.length} passed quality gate`);

            return validBenchmarks.length > 0 ? validBenchmarks : this.getEmptyFallback();

        } catch (error) {
            console.error(`   ❌ Fetch error: ${error.message}`);
            return this.getEmptyFallback();
        }
    }

    /**
     * Fetch benchmark data directly from the official results dataset tree
     * @param {string} author 
     * @param {string} modelId 
     */
    async fetchAuthoritativeBenchmark(author, modelId) {
        try {
            const treeUrl = `${LEADERBOARD_TREE_API}/${author}/${modelId}`;
            const response = await fetch(treeUrl);
            if (!response.ok) return null;

            const files = await response.json();
            const resultFiles = files
                .filter(f => f.type === 'file' && f.path.endsWith('.json'))
                .sort((a, b) => b.path.localeCompare(a.path)); // Latest first

            if (resultFiles.length === 0) return null;

            const latestFile = resultFiles[0].path;
            const rawUrl = `${LEADERBOARD_RAW_BASE}/${latestFile}`;

            console.log(`      🎯 Found authoritative result: ${latestFile}`);
            const res = await fetch(rawUrl);
            if (!res.ok) return null;

            const data = await res.json();
            return this.normalizeAuthoritative(data, author, modelId);
        } catch (e) {
            console.warn(`      ⚠️ Authoritative fetch failed for ${author}/${modelId}: ${e.message}`);
            return null;
        }
    }

    /**
     * Normalize JSON from the official open-llm-leaderboard/results dataset
     */
    normalizeAuthoritative(data, author, modelId) {
        // V2 results are deeply nested under 'results'
        const results = data.results || {};

        // Map common benchmark tasks (V1 and V2 names)
        const getScore = (patterns) => {
            for (const key of Object.keys(results)) {
                if (patterns.some(p => key.toLowerCase().includes(p))) {
                    const obj = results[key] || {};
                    // V2 metrics often have ",none" suffix in the key itself
                    // Prioritize acc_norm for consistency with V2 leaderboard UI
                    const val = obj.acc_norm || obj['acc_norm,none'] ||
                        obj.acc || obj['acc,none'] ||
                        obj.exact_match || obj['exact_match,none'] ||
                        obj.norm || obj['norm,none'] ||
                        obj.value || obj['value,none'];

                    if (val !== undefined && val !== null) {
                        const parsed = this.parseScore(val);
                        if (parsed !== null && !isNaN(parsed)) return parsed;
                    }
                }
            }
            return null;
        };

        const mmlu = getScore(['mmlu_pro', 'mmlu']);
        const arc = getScore(['arc:challenge', 'arc_challenge', 'arc']);
        const hellaswag = getScore(['hellaswag']);
        const truthfulqa = getScore(['truthfulqa:mc', 'truthfulqa_mc2', 'truthfulqa']);
        const gsm8k = getScore(['gsm8k', 'math_hard']); // gsm8k is part of math_hard in V2
        const winogrande = getScore(['winogrande']);

        const scores = [mmlu, arc, hellaswag, truthfulqa, gsm8k, winogrande].filter(s => s !== null);
        const avgScore = scores.length > 0
            ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100
            : 0;

        if (avgScore === 0) return null;

        return {
            model_name: `${author}/${modelId}`,
            normalized_name: this.normalizeBenchName(`${author}/${modelId}`),
            source: 'open_llm_leaderboard_v2',
            mmlu,
            humaneval: null,
            truthfulqa,
            hellaswag,
            arc_challenge: arc,
            winogrande,
            gsm8k,
            avg_score: avgScore,
            quality_flag: this.validateBenchmark({ mmlu, hellaswag, arc, avgScore }),
            eval_meta: JSON.stringify({
                source_url: `https://huggingface.co/datasets/open-llm-leaderboard/results/tree/main/${author}/${modelId}`,
                version: 'v2_authoritative',
                evaluated_at: data.date || data.config?.time || new Date().toISOString()
            })
        };
    }

    /**
     * Extract benchmark scores from model card/evaluation results
     * @param {Object} model - HuggingFace model object
     */
    async extractBenchmarksFromModel(model) {
        try {
            // Try to get evaluation results from model card
            const cardData = model.cardData || {};
            const evalResults = cardData.eval_results || cardData.model_index?.[0]?.results || [];

            let mmlu = null, hellaswag = null, arc = null, truthfulqa = null;

            // Parse eval_results if available
            for (const result of evalResults) {
                const taskName = (result.task?.name || result.dataset?.name || '').toLowerCase();
                const score = result.metrics?.[0]?.value || result.value;

                if (taskName.includes('mmlu')) mmlu = this.parseScore(score);
                if (taskName.includes('hellaswag')) hellaswag = this.parseScore(score);
                if (taskName.includes('arc')) arc = this.parseScore(score);
                if (taskName.includes('truthful')) truthfulqa = this.parseScore(score);
            }

            // Calculate average if we have any scores
            const scores = [mmlu, hellaswag, arc, truthfulqa].filter(s => s !== null);
            const avgScore = scores.length > 0
                ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100
                : 0;

            if (avgScore === 0) return null;

            const qualityFlag = this.validateBenchmark({ mmlu, hellaswag, arc, avgScore });

            return {
                model_name: model.id || model.modelId,
                normalized_name: this.normalizeBenchName(model.id || ''),
                source: 'huggingface_eval',
                mmlu,
                humaneval: null,
                truthfulqa,
                hellaswag,
                arc_challenge: arc,
                winogrande: null,
                gsm8k: null,
                avg_score: avgScore,
                quality_flag: qualityFlag,
                eval_meta: JSON.stringify({
                    source_url: `https://huggingface.co/${model.id}`,
                    downloads: model.downloads,
                    likes: model.likes,
                    extracted_from: 'model_card'
                })
            };
        } catch (e) {
            return null;
        }
    }

    /**
     * Normalize raw leaderboard data to model_benchmarks schema
     * @param {Object} raw - Raw leaderboard record
     * @returns {Object} Normalized benchmark record
     */
    normalize(raw) {
        const modelName = raw.model || raw.Model || raw.fullname || '';
        const normalizedName = this.normalizeBenchName(modelName);

        // Extract benchmark scores
        const mmlu = this.parseScore(raw.MMLU || raw['Average ⬆️']);
        const humaneval = this.parseScore(raw.HumanEval);
        const truthfulqa = this.parseScore(raw.TruthfulQA || raw['truthfulqa_mc2']);
        const hellaswag = this.parseScore(raw.HellaSwag || raw['hellaswag']);
        const arc = this.parseScore(raw.ARC || raw['arc_challenge']);
        const winogrande = this.parseScore(raw.Winogrande || raw['winogrande']);
        const gsm8k = this.parseScore(raw.GSM8K || raw['gsm8k']);

        // Calculate average score
        const scores = [mmlu, humaneval, truthfulqa, hellaswag, arc, winogrande, gsm8k]
            .filter(s => s !== null && !isNaN(s));
        const avgScore = scores.length > 0
            ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100
            : null;

        // Apply V4.3.2 Benchmark Plausibility Gate
        const qualityFlag = this.validateBenchmark({
            mmlu, hellaswag, arc, avgScore
        });

        return {
            model_name: modelName,
            normalized_name: normalizedName,
            source: 'open_llm_leaderboard',
            mmlu,
            humaneval,
            truthfulqa,
            hellaswag,
            arc_challenge: arc,
            winogrande,
            gsm8k,
            avg_score: avgScore,
            quality_flag: qualityFlag,
            eval_meta: JSON.stringify({
                source_url: `https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard`,
                evaluated_at: raw.date || new Date().toISOString(),
                raw_fields: Object.keys(raw)
            })
        };
    }

    /**
     * Parse benchmark score to number
     * @param {any} value 
     * @returns {number|null}
     */
    parseScore(value) {
        if (value === null || value === undefined || value === '') return null;
        const num = parseFloat(value);
        if (isNaN(num)) return null;
        // Convert to percentage if needed (some scores are 0-1)
        return num <= 1 && num > 0 ? num * 100 : num;
    }

    /**
     * V4.3.2 Benchmark Plausibility Gate
     * @param {Object} scores 
     * @returns {'ok'|'suspect'|'invalid'}
     */
    validateBenchmark(scores) {
        const { mmlu, hellaswag, arc, avgScore } = scores;

        // Invalid: scores out of range
        const allScores = [mmlu, hellaswag, arc, avgScore].filter(s => s !== null);
        if (allScores.some(s => s < 0 || s > 100)) {
            return 'invalid';
        }

        // Suspect: all scores suspiciously low (random guessing level)
        const sum = (mmlu || 0) + (hellaswag || 0) + (arc || 0);

        // V4.3.4 Adjustment: Some early evaluations in V2 may have very low scores or only 1 metric
        // Use a more relaxed gate if avgScore is non-zero
        if (sum > 0 && sum < 15) { // Relaxed from 75 to 15 to allow emerging models
            return 'suspect';
        }

        return 'ok';
    }

    /**
     * Normalize benchmark model name for UMID matching
     * V4.3.2 Constitution compliant
     * @param {string} name 
     * @returns {string}
     */
    normalizeBenchName(name) {
        return name
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .replace(/-(instruct|chat|base)$/, '')
            .replace(/-(v\d+)$/, '-$1')
            .replace(/-(7b|8b|13b|14b|32b|70b|72b)/, '-$1');
    }

    /**
     * V16.3: Strictly return empty to prevent registry pollution
     * V19.5: Deprecated December 2024 mock data entirely. MUST strictly fail-open and return empty array.
     * Rendering stale benchmark datasets permanently harms architectural integrity.
     */
    getEmptyFallback() {
        console.warn('   ⚠️ Live fetch returned zero results. Strict Fail-Open: Returning empty array to prevent stale benchmarking data pollution.');
        return [];
    }

    /**
     * Attempt to resolve benchmark record to existing model UMID
     * @param {Object} benchRecord 
     * @param {D1Database} db 
     * @returns {Promise<{umid: string|null, confidence: number}>}
     */
    async resolveToUMID(benchRecord, db) {
        const normalizedName = benchRecord.normalized_name;

        // Layer 1: Exact canonical_name match
        let match = await db.prepare(`
            SELECT umid, canonical_name FROM models 
            WHERE canonical_name = ? 
            LIMIT 1
        `).bind(normalizedName).first();

        if (match) {
            return { umid: match.umid, confidence: 1.0 };
        }

        // Layer 2: Fuzzy match with LIKE
        const searchPattern = `%${normalizedName.slice(0, 15)}%`;
        const candidates = await db.prepare(`
            SELECT umid, canonical_name FROM models 
            WHERE canonical_name LIKE ? 
            LIMIT 10
        `).bind(searchPattern).all();

        if (candidates.results && candidates.results.length > 0) {
            // Simple similarity check
            for (const candidate of candidates.results) {
                if (candidate.canonical_name.includes(normalizedName.split('-').slice(0, 3).join('-'))) {
                    return { umid: candidate.umid, confidence: 0.75 };
                }
            }
        }

        // No match found
        return { umid: null, confidence: 0 };
    }
}

export default OpenLLMLeaderboardAdapter;
