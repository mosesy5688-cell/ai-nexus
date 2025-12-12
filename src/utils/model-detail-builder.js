// src/utils/model-detail-builder.js
/**
 * Model Detail Builder V4.5 (S-Grade)
 * Constitution V4.3.2 Compliant
 * 
 * Features:
 * - Mandatory field fallbacks
 * - Full JSON-LD SEO schema (with Dataset for benchmarks)
 * - Pre-rendered markdown
 * - Safe JSON parsing
 * - Single-fetch data aggregation
 */

import { marked } from 'marked';

// ============================================
// SAFE PARSING UTILITIES
// ============================================

/**
 * Safely parse JSON with fallback
 * @param {string|object|null} value - Value to parse
 * @param {any} fallback - Fallback value
 * @returns {any}
 */
export function safeParseJSON(value, fallback = null) {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return fallback;

    try {
        const parsed = JSON.parse(value);
        return parsed ?? fallback;
    } catch {
        return fallback;
    }
}

/**
 * Safely get string with fallback
 * @param {any} value - Value
 * @param {string} fallback - Fallback
 * @returns {string}
 */
export function safeString(value, fallback = '') {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string') return value;
    return String(value);
}

/**
 * Safely get number with fallback
 * @param {any} value - Value
 * @param {number} fallback - Fallback
 * @returns {number}
 */
export function safeNumber(value, fallback = 0) {
    if (value === null || value === undefined) return fallback;
    const num = Number(value);
    return isNaN(num) ? fallback : num;
}

/**
 * Truncate text to max length
 * @param {string} text - Text
 * @param {number} maxLength - Max length
 * @returns {string}
 */
export function truncate(text, maxLength = 160) {
    if (!text || typeof text !== 'string') return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
}

// ============================================
// MARKDOWN RENDERING
// ============================================

/**
 * Safely render markdown to HTML
 * @param {string} markdown - Markdown content
 * @returns {string}
 */
export function renderMarkdown(markdown) {
    if (!markdown || typeof markdown !== 'string') return '';

    try {
        // Clean up common issues
        const cleaned = markdown
            .replace(/^---[\s\S]*?---\n?/m, '') // Remove YAML frontmatter
            .substring(0, 50000); // Limit size

        return marked.parse(cleaned);
    } catch {
        return `<p>${markdown.substring(0, 1000)}</p>`;
    }
}

// ============================================
// DATA EXTRACTION
// ============================================

/**
 * Get display name from model
 * @param {object} model - Model object
 * @returns {string}
 */
export function getDisplayName(model) {
    if (!model) return 'Unknown Model';
    return model.name || model.canonical_name || model.id || 'Unknown Model';
}

/**
 * Get best description for display
 * @param {object} model - Model object
 * @returns {string}
 */
export function getBestDescription(model) {
    if (!model) return 'AI model on Free AI Tools.';

    // Priority: seo_summary > notebooklm_summary > description
    const desc = model.seo_summary || model.notebooklm_summary || model.description || '';

    // Clean markdown artifacts
    return desc
        .replace(/^---[\s\S]*?---\n?/m, '')
        .replace(/[#*`]/g, '')
        .substring(0, 500)
        .trim() || 'AI model on Free AI Tools.';
}

/**
 * Parse benchmarks with fallbacks
 * @param {object} model - Model object
 * @returns {object}
 */
export function parseBenchmarks(model) {
    return {
        mmlu: safeNumber(model?.benchmark_mmlu, null),
        hellaswag: safeNumber(model?.benchmark_hellaswag, null),
        arc: safeNumber(model?.benchmark_arc, null),
        avg_score: safeNumber(model?.benchmark_avg, null),
        has_benchmarks: Boolean(model?.has_benchmarks)
    };
}

/**
 * Parse specs with fallbacks
 * @param {object} model - Model object
 * @returns {object}
 */
export function parseSpecs(model) {
    return {
        params: safeNumber(model?.params_billions, null),
        context_length: safeNumber(model?.context_length, null),
        has_gguf: Boolean(model?.has_gguf),
        gguf_variants: safeParseJSON(model?.gguf_variants, []),
        has_ollama: Boolean(model?.has_ollama),
        ollama_id: safeString(model?.ollama_id, null),
        ollama_pulls: safeNumber(model?.ollama_pulls, 0),
        architecture_family: safeString(model?.architecture_family, null),
        license: safeString(model?.license_spdx, null)
    };
}

/**
 * Build FNI data with fallbacks
 * @param {object} model - Model object
 * @returns {object}
 */
export function buildFNI(model) {
    return {
        score: safeNumber(model?.fni_score, 0),
        percentile: safeNumber(model?.fni_percentile, 0),
        p: safeNumber(model?.fni_p, 0),
        v: safeNumber(model?.fni_v, 0),
        c: safeNumber(model?.fni_c, 0),
        u: safeNumber(model?.fni_u, 0),
        commentary: safeString(model?.fni_commentary, null)
    };
}

// ============================================
// SEO SCHEMA BUILDERS (S-GRADE)
// ============================================

/**
 * Build full JSON-LD SEO schema (S-Grade with Dataset)
 * @param {object} model - Model object
 * @param {object} benchmarks - Benchmark data
 * @param {object} specs - Specs data
 * @returns {object}
 */
export function buildSEOSchema(model, benchmarks, specs) {
    const baseUrl = 'https://free2aitools.com';
    const modelUrl = `${baseUrl}/model/${model?.slug || model?.umid || model?.id}`;

    const graph = [
        // SoftwareApplication
        {
            '@type': 'SoftwareApplication',
            '@id': modelUrl,
            'name': getDisplayName(model),
            'description': truncate(getBestDescription(model), 300),
            'applicationCategory': 'AI Model',
            'operatingSystem': 'Cross-platform',
            'downloadUrl': model?.source_url || null,
            'author': {
                '@type': 'Organization',
                'name': model?.author || 'Unknown'
            },
            'license': specs?.license ? `https://spdx.org/licenses/${specs.license}` : null
        },

        // BreadcrumbList
        {
            '@type': 'BreadcrumbList',
            'itemListElement': [
                { '@type': 'ListItem', 'position': 1, 'name': 'Home', 'item': baseUrl },
                { '@type': 'ListItem', 'position': 2, 'name': 'Models', 'item': `${baseUrl}/explore` },
                { '@type': 'ListItem', 'position': 3, 'name': getDisplayName(model), 'item': modelUrl }
            ]
        },

        // Offer (free)
        {
            '@type': 'Offer',
            'price': '0',
            'priceCurrency': 'USD',
            'availability': 'https://schema.org/InStock'
        }
    ];

    // Product for specs (S-Grade)
    if (specs?.params || specs?.context_length) {
        graph.push({
            '@type': 'Product',
            'name': `${getDisplayName(model)} Specifications`,
            'description': [
                specs.params ? `${specs.params}B parameters` : null,
                specs.context_length ? `${specs.context_length}K context` : null,
                specs.has_gguf ? 'GGUF available' : null,
                specs.has_ollama ? 'Ollama ready' : null
            ].filter(Boolean).join(', ') || 'AI model specifications'
        });
    }

    // Dataset for benchmarks (S-Grade)
    if (benchmarks?.has_benchmarks) {
        if (benchmarks.mmlu !== null) {
            graph.push({
                '@type': 'Dataset',
                'name': `MMLU Benchmark for ${getDisplayName(model)}`,
                'description': `Massive Multitask Language Understanding score: ${benchmarks.mmlu}%`,
                'measurementTechnique': 'MMLU',
                'variableMeasured': {
                    '@type': 'PropertyValue',
                    'name': 'Mean Accuracy',
                    'value': benchmarks.mmlu,
                    'unitText': 'percent'
                }
            });
        }

        if (benchmarks.hellaswag !== null) {
            graph.push({
                '@type': 'Dataset',
                'name': `HellaSwag Benchmark for ${getDisplayName(model)}`,
                'description': `Commonsense reasoning score: ${benchmarks.hellaswag}%`,
                'measurementTechnique': 'HellaSwag',
                'variableMeasured': {
                    '@type': 'PropertyValue',
                    'name': 'Accuracy',
                    'value': benchmarks.hellaswag,
                    'unitText': 'percent'
                }
            });
        }

        if (benchmarks.arc !== null) {
            graph.push({
                '@type': 'Dataset',
                'name': `ARC Benchmark for ${getDisplayName(model)}`,
                'description': `AI2 Reasoning Challenge score: ${benchmarks.arc}%`,
                'measurementTechnique': 'ARC',
                'variableMeasured': {
                    '@type': 'PropertyValue',
                    'name': 'Accuracy',
                    'value': benchmarks.arc,
                    'unitText': 'percent'
                }
            });
        }
    }

    return {
        '@context': 'https://schema.org',
        '@graph': graph.filter(item => item !== null)
    };
}

/**
 * Build SEO metadata
 * @param {object} model - Model object
 * @param {object} benchmarks - Benchmarks
 * @param {object} specs - Specs
 * @returns {object}
 */
export function buildSEOMeta(model, benchmarks, specs) {
    const displayName = getDisplayName(model);
    const author = model?.author || 'Unknown';

    // Build rich title with specs
    let title = `${displayName} by ${author}`;
    const titleExtras = [];
    if (specs?.params) titleExtras.push(`${specs.params}B`);
    if (specs?.has_gguf) titleExtras.push('GGUF');
    if (specs?.has_ollama) titleExtras.push('Ollama');
    if (titleExtras.length > 0) {
        title += ` — ${titleExtras.join(' | ')}`;
    }
    title += ' | Free AI Tools';

    // Description with benchmarks
    let description = getBestDescription(model);
    if (benchmarks?.has_benchmarks && benchmarks.avg_score) {
        description = `Benchmark: ${benchmarks.avg_score.toFixed(1)}% avg. ${description}`;
    }

    return {
        title: truncate(title, 70),
        description: truncate(description, 160),
        canonical: `https://free2aitools.com/model/${model?.slug || model?.umid || model?.id}`,
        ogImage: model?.cover_image_url || '/default-model.png',
        jsonLd: buildSEOSchema(model, benchmarks, specs)
    };
}

// ============================================
// DATA FETCHERS
// ============================================

/**
 * Fetch similar models
 * @param {object} model - Model object
 * @param {object} locals - Astro locals
 * @param {number} limit - Limit
 * @returns {Promise<array>}
 */
export async function fetchSimilarModels(model, locals, limit = 6) {
    const db = locals?.runtime?.env?.DB;
    if (!db || !model) return [];

    try {
        // By pipeline tag
        if (model.pipeline_tag) {
            const result = await db.prepare(`
                SELECT id, name, author, likes, downloads, cover_image_url, fni_score, pipeline_tag
                FROM models
                WHERE pipeline_tag = ? AND id != ?
                ORDER BY downloads DESC
                LIMIT ?
            `).bind(model.pipeline_tag, model.id, limit).all();

            if (result?.results?.length > 0) return result.results;
        }

        // Fallback: top models
        const result = await db.prepare(`
            SELECT id, name, author, likes, downloads, cover_image_url, fni_score, pipeline_tag
            FROM models
            WHERE id != ?
            ORDER BY downloads DESC
            LIMIT ?
        `).bind(model.id, limit).all();

        return result?.results || [];
    } catch (e) {
        console.error('[Detail Builder] Fetch similar error:', e);
        return [];
    }
}

/**
 * Fetch related models by tag
 * @param {object} model - Model object
 * @param {object} locals - Astro locals
 * @param {number} limit - Limit
 * @returns {Promise<array>}
 */
export async function fetchRelatedModels(model, locals, limit = 6) {
    const db = locals?.runtime?.env?.DB;
    if (!db || !model) return [];

    try {
        const relatedIds = safeParseJSON(model.related_ids, []);

        if (relatedIds.length > 0) {
            const placeholders = relatedIds.slice(0, limit).map(() => '?').join(',');
            const result = await db.prepare(`
                SELECT id, name, author, likes, downloads, cover_image_url, fni_score
                FROM models
                WHERE id IN (${placeholders})
                LIMIT ?
            `).bind(...relatedIds.slice(0, limit), limit).all();

            if (result?.results?.length > 0) return result.results;
        }

        return [];
    } catch (e) {
        console.error('[Detail Builder] Fetch related error:', e);
        return [];
    }
}

// ============================================
// MAIN BUILDER (S-GRADE)
// ============================================

/**
 * Build complete model detail object
 * @param {object} model - Raw model from DB
 * @param {object} locals - Astro locals with DB/KV bindings
 * @returns {Promise<object|null>}
 */
export async function buildModelDetail(model, locals) {
    if (!model) return null;

    // Parse all structured data
    const benchmarks = parseBenchmarks(model);
    const specs = parseSpecs(model);
    const fni = buildFNI(model);
    const tags = safeParseJSON(model.tags, []);
    const resources = safeParseJSON(model.resources, []);
    const commercialSlots = safeParseJSON(model.commercial_slots, []);

    // Build SEO
    const seo = buildSEOMeta(model, benchmarks, specs);

    // Fetch related data (single pass)
    const [similarModels, relatedModels] = await Promise.all([
        fetchSimilarModels(model, locals, 6),
        fetchRelatedModels(model, locals, 6)
    ]);

    // Pre-render markdown
    const readmeHtml = renderMarkdown(model.description || '');
    const analysisHtml = renderMarkdown(model.analysis_content || '');

    return {
        // Core model
        model,
        displayName: getDisplayName(model),
        author: safeString(model.author, 'Unknown'),

        // SEO (S-Grade with Dataset JSON-LD)
        seo,

        // Pre-rendered content
        readmeHtml,
        analysisHtml,

        // Related
        similarModels,
        relatedModels,

        // V4.4 Features
        benchmarks,
        specs,
        deployScore: safeNumber(model.deploy_score, 0),

        // Commerce
        commercialSlots,

        // UI Data
        tags: Array.isArray(tags) ? tags : [],
        resources: Array.isArray(resources) ? resources : [],
        fni,

        // Images with fallback
        coverImage: model.cover_image_url || '/default-model.png',
        sourceUrl: model.source_url || null,

        // Timestamps
        lastUpdated: model.last_updated || model.first_indexed || null,

        // UMID
        umid: model.umid || null
    };
}

// ============================================
// COMPARE DELTA CALCULATION (S-GRADE)
// ============================================

/**
 * Calculate benchmark delta between two models
 * @param {object} modelA - First model detail
 * @param {object} modelB - Second model detail
 * @returns {object}
 */
export function calculateBenchmarkDelta(modelA, modelB) {
    if (!modelA?.benchmarks || !modelB?.benchmarks) {
        return { available: false };
    }

    const delta = {
        available: true,
        mmlu: null,
        hellaswag: null,
        arc: null,
        avg: null,
        winner: null
    };

    // Calculate deltas
    if (modelA.benchmarks.mmlu !== null && modelB.benchmarks.mmlu !== null) {
        delta.mmlu = modelA.benchmarks.mmlu - modelB.benchmarks.mmlu;
    }

    if (modelA.benchmarks.hellaswag !== null && modelB.benchmarks.hellaswag !== null) {
        delta.hellaswag = modelA.benchmarks.hellaswag - modelB.benchmarks.hellaswag;
    }

    if (modelA.benchmarks.arc !== null && modelB.benchmarks.arc !== null) {
        delta.arc = modelA.benchmarks.arc - modelB.benchmarks.arc;
    }

    if (modelA.benchmarks.avg_score !== null && modelB.benchmarks.avg_score !== null) {
        delta.avg = modelA.benchmarks.avg_score - modelB.benchmarks.avg_score;
        delta.winner = delta.avg > 0 ? 'A' : delta.avg < 0 ? 'B' : 'tie';
    }

    return delta;
}
