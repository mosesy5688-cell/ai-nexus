/**
 * Ollama Adapter — HONEST-DOWNGRADE (V28 PR-D)
 *
 * Constitution V3.3 Data Expansion - "Runtime First" Strategy.
 *
 * HONEST FRAMING: this adapter does NOT scrape the ollama.com Library and does
 * NOT enumerate a live registry. It probes the LOCAL Ollama daemon
 * (http://127.0.0.1:11434) for models installed on the harvesting machine. In CI
 * no daemon exists, so the daemon probe always fails and we emit a small,
 * statically-curated SEED of well-known Ollama model names (getSeedModels) — that
 * SEED is the real production output here, not a live snapshot. Each seed row is
 * marked `is_fallback: true`; no field claims pull counts, freshness, or coverage
 * it does not have. We intentionally do NOT invest in live ollama.com scraping.
 *
 * The local-daemon branch is retained so a developer running against a populated
 * daemon still gets richer (modelfile/params) local data, but the contract makes
 * no promise of that in prod.
 *
 * V2.1: Added NSFW filter at fetch level
 *
 * @module scripts/ingestion/adapters/ollama-adapter
 */

import { BaseAdapter, NSFW_KEYWORDS } from './base-adapter.js';
import { extractDatasetsFromText } from '../../../src/utils/dataset-extractor.js';

/**
 * Common model name aliases for fuzzy matching
 */
const MODEL_ALIASES = {
    'llama3': ['meta-llama/Meta-Llama-3-8B', 'meta-llama/Meta-Llama-3-8B-Instruct', 'meta-llama/llama-3-8b'],
    'llama3.1': ['meta-llama/Meta-Llama-3.1-8B', 'meta-llama/Llama-3.1-8B-Instruct'],
    'llama3.2': ['meta-llama/Llama-3.2-1B', 'meta-llama/Llama-3.2-3B'],
    'mistral': ['mistralai/Mistral-7B-v0.1', 'mistralai/Mistral-7B-Instruct-v0.2', 'mistralai/Mistral-7B-Instruct-v0.3'],
    'mixtral': ['mistralai/Mixtral-8x7B-v0.1', 'mistralai/Mixtral-8x7B-Instruct-v0.1'],
    'phi3': ['microsoft/phi-3', 'microsoft/Phi-3-mini-4k-instruct'],
    'phi': ['microsoft/phi-2', 'microsoft/phi-1_5'],
    'gemma': ['google/gemma-7b', 'google/gemma-2b'],
    'gemma2': ['google/gemma-2-9b', 'google/gemma-2-27b'],
    'qwen2': ['Qwen/Qwen2-7B', 'Qwen/Qwen2-72B'],
    'qwen2.5': ['Qwen/Qwen2.5-7B', 'Qwen/Qwen2.5-72B'],
    'codellama': ['codellama/CodeLlama-7b-hf', 'codellama/CodeLlama-13b-hf'],
    'deepseek-coder': ['deepseek-ai/deepseek-coder-6.7b-base', 'deepseek-ai/deepseek-coder-33b-instruct'],
    'starcoder2': ['bigcode/starcoder2-15b', 'bigcode/starcoder2-7b'],
    'yi': ['01-ai/Yi-6B', '01-ai/Yi-34B'],
    'command-r': ['CohereForAI/c4ai-command-r-v01'],
    'vicuna': ['lmsys/vicuna-7b-v1.5', 'lmsys/vicuna-13b-v1.5'],
    'falcon': ['tiiuae/falcon-7b', 'tiiuae/falcon-40b'],
    'solar': ['upstage/SOLAR-10.7B-v1.0'],
    'openchat': ['openchat/openchat-3.5-0106'],
    'dolphin-mistral': ['cognitivecomputations/dolphin-2.6-mistral-7b'],
    'neural-chat': ['Intel/neural-chat-7b-v3-1'],
    'starling-lm': ['berkeley-nest/Starling-LM-7B-alpha'],
    'orca2': ['microsoft/Orca-2-7b', 'microsoft/Orca-2-13b'],
    'stable-code': ['stabilityai/stable-code-3b'],
    'wizardcoder': ['WizardLM/WizardCoder-Python-7B-V1.0'],
    'wizard-vicuna': ['WizardLM/WizardLM-7B-V1.0', 'WizardLM/WizardLM-13B-V1.2'],
    'zephyr': ['HuggingFaceH4/zephyr-7b-beta'],
    'tinyllama': ['TinyLlama/TinyLlama-1.1B-Chat-v1.0'],
    'stablelm': ['stabilityai/stablelm-3b-4e1t'],
};

export class OllamaAdapter extends BaseAdapter {
    constructor() {
        // V28 (PR-D): the old `super('ollama', 'Ollama Library')` 2nd arg was a
        // misleading "Library" display label (BaseAdapter takes only sourceName,
        // so it was silently ignored AND falsely implied live-Library coverage).
        super('ollama');
    }

    /**
     * Probe the LOCAL Ollama daemon for installed models; in CI / when no daemon
     * is reachable, emit the honest curated SEED (see class header). NOT a live
     * ollama.com registry scrape.
     */
    async fetch(options = {}) {
        const { limit = 100, onBatch } = options;
        console.log('[Ollama] Probing local daemon; falling back to curated seed if unreachable...');

        try {
            const ollamaModels = await this.fetchLocalOrSeed();
            const slicedModels = ollamaModels.slice(0, limit);

            console.log(`[Ollama] Yielding ${slicedModels.length} models`);

            if (onBatch) {
                await onBatch(slicedModels);
                return [];
            }

            return slicedModels;

        } catch (error) {
            console.error('[Ollama] Fetch error:', error.message);
            return [];
        }
    }

    /**
     * Normalize Ollama model data to unified schema
     * Required by BaseAdapter contract
     */
    normalize(raw) {
        const ollamaId = raw.ollama_id || raw.name || 'unknown';
        const modelfileText = raw.modelfile ? `\n\n## Modelfile\n\`\`\`dockerfile\n${raw.modelfile}\n\`\`\`\n` : '';
        const paramsText = raw.parameters ? `\n\n## Parameters\n\`\`\`text\n${raw.parameters}\n\`\`\`\n` : '';
        // V27.72: regex-extract datasets from description/modelfile/params (ollama
        // metadata has no structured datasets field; whitelist guards against poisoning).
        const corpus = `${raw.description || ''} ${raw.modelfile || ''} ${raw.parameters || ''}`;
        // V28 (PR-D) honest-downgrade: a fallback/seed row carries NO live timestamp.
        // Stamping created_at/updated_at = now would falsely advertise this static
        // seed as freshly-harvested data. Only the live local-daemon path gets a
        // real "seen now" timestamp.
        const isFallback = raw.is_fallback === true;
        const nowOrNull = isFallback ? null : new Date().toISOString();
        const entity = {
            // Identity
            id: this.generateId('ollama', ollamaId, 'model'),
            type: 'model',
            source: 'ollama',
            source_url: raw.source_url || `https://ollama.com/library/${ollamaId}`,

            // Content
            title: raw.name || ollamaId,
            description: this.truncate(raw.description || `Ollama model: ${ollamaId}. Run locally with: ollama run ${ollamaId}`, 500),
            body_content: `${raw.description || ''}\n${modelfileText}${paramsText}`.trim(),
            tags: ['ollama', 'local-deployment'],
            datasets_used: extractDatasetsFromText(corpus),  // V27.72

            // V6.0: Pipeline tag for category assignment (all Ollama models are text-generation LLMs)
            pipeline_tag: 'text-generation',

            // Metadata
            author: 'ollama',
            license_spdx: null,
            meta_json: {
                ollama: {
                    id: ollamaId,
                    url: raw.source_url || `https://ollama.com/library/${ollamaId}`,
                    is_fallback: isFallback,
                    details: raw.details || null,
                    parameters: raw.parameters || null
                }
            },
            created_at: nowOrNull,
            updated_at: nowOrNull,

            // Metrics
            popularity: raw.pulls || 0,
            downloads: raw.pulls || 0,

            // Assets
            raw_image_url: null,

            // Relations
            relations: [],

            // Ollama-specific flags
            // V28 (PR-D): surface is_fallback at top level (was buried only in
            // meta_json) so downstream can honestly distinguish a curated seed row
            // from a live local-daemon row.
            is_fallback: isFallback,
            has_ollama: true,
            ollama_id: ollamaId,
            ollama_pulls: raw.pulls || 0,

            // System fields
            content_hash: null,
            compliance_status: null,
            quality_score: null
        };

        // Calculate system fields after entity creation
        entity.content_hash = this.generateContentHash(entity);
        entity.compliance_status = this.getComplianceStatus(entity);
        entity.quality_score = this.calculateQualityScore(entity);

        return entity;
    }

    /**
     * Probe the LOCAL Ollama daemon (http://127.0.0.1:11434) for installed models.
     * V28 (PR-D) honest-downgrade: this is a LOCAL-daemon probe, not an ollama.com
     * Library scrape. When the daemon is unreachable (the CI / prod case) it returns
     * the curated SEED (getSeedModels). No claim of live registry coverage.
     */
    async fetchLocalOrSeed() {
        console.log('[Ollama] Connecting to local daemon JSON API (http://127.0.0.1:11434)...');
        try {
            // 1. Fetch available local models
            const response = await fetch('http://127.0.0.1:11434/api/tags', {
                headers: { 'Accept': 'application/json' },
                // Use a short timeout so CI doesn't drag if Ollama isn't running
                signal: AbortSignal.timeout(3000)
            });

            if (!response.ok) {
                console.warn('[Ollama] Local daemon API error:', response.status);
                return this.getSeedModels();
            }

            const data = await response.json();
            if (!data.models || data.models.length === 0) {
                return this.getSeedModels();
            }

            const models = [];

            // 2. Extract deep Modelfile data for each local deployment
            for (const m of data.models) {
                // Strip the tag for standard naming (e.g., llama3:latest -> llama3)
                const baseName = m.name.split(':')[0];
                let pulls = 0;
                let modelfile = null;
                let parameters = null;

                try {
                    // V28: bounded request (was un-timed) so a hung local daemon can't stall CI.
                    const showRes = await this.fetchWithTimeout('http://127.0.0.1:11434/api/show', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: m.name })
                    }, 3000);

                    if (showRes.ok) {
                        const showData = await showRes.json();
                        modelfile = showData.modelfile;
                        parameters = showData.parameters;
                    }
                } catch (e) {
                    console.warn(`[Ollama] Could not fetch deeper details for ${m.name}`);
                }

                // Push enhanced dataset
                if (!models.find(x => x.ollama_id === baseName)) {
                    models.push({
                        ollama_id: baseName,
                        name: m.name,
                        // V28 (PR-D): true pull counts are NOT exposed by the local
                        // daemon. Leaving pulls=0 (honest) instead of reusing on-disk
                        // size as a fake popularity metric, which it never was.
                        pulls: 0,
                        source_url: `https://ollama.com/library/${baseName}`,
                        details: m.details,
                        modelfile,
                        parameters,
                        is_local: true
                    });
                }
            }

            return models.length > 0 ? models : this.getSeedModels();

        } catch (error) {
            console.warn('[Ollama] Local daemon unreachable, using curated seed:', error.message);
            return this.getSeedModels();
        }
    }

    /**
     * Curated SEED of well-known Ollama model names (V28 PR-D honest-downgrade).
     * This is the REAL production output in CI (no local daemon). It is a static,
     * honestly-labeled list — NOT a live ollama.com snapshot — so every row carries
     * `is_fallback: true` and no popularity/freshness claim. Kept intentionally
     * minimal; we do not invest in live ollama.com scraping.
     */
    getSeedModels() {
        return Object.keys(MODEL_ALIASES).map(ollamaId => ({
            ollama_id: ollamaId,
            name: ollamaId,
            source_url: `https://ollama.com/library/${ollamaId}`,
            is_fallback: true
        }));
    }

    /**
     * Match Ollama model to HuggingFace model
     */
    matchToHuggingFace(ollamaId, hfModels) {
        // 1. Check explicit alias mapping
        const aliases = MODEL_ALIASES[ollamaId.toLowerCase()];
        if (aliases) {
            for (const alias of aliases) {
                const match = hfModels.find(m =>
                    m.id?.toLowerCase() === alias.toLowerCase() ||
                    m.source_url?.includes(alias)
                );
                if (match) return match;
            }
        }

        // 2. Fuzzy match by name
        const normalizedOllama = this.normalizeModelName(ollamaId);
        for (const hfModel of hfModels) {
            const normalizedHF = this.normalizeModelName(hfModel.name || hfModel.id);
            if (normalizedOllama === normalizedHF) {
                return hfModel;
            }
        }

        // 3. Partial match
        for (const hfModel of hfModels) {
            const hfName = (hfModel.name || hfModel.id || '').toLowerCase();
            if (hfName.includes(normalizedOllama) || normalizedOllama.includes(hfName.split('/').pop())) {
                return hfModel;
            }
        }

        return null;
    }

    /**
     * Normalize model name for matching
     */
    normalizeModelName(name) {
        return (name || '')
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '')
            .replace(/instruct/g, '')
            .replace(/chat/g, '')
            .replace(/base/g, '')
            .replace(/hf$/g, '');
    }

    /**
     * Enrich existing models with Ollama data
     */
    async enrichModels(existingModels) {
        console.log('[Ollama] Enriching models with Ollama data...');

        const ollamaModels = await this.fetch();
        let enriched = 0;
        let notMatched = [];

        for (const ollama of ollamaModels) {
            const match = this.matchToHuggingFace(ollama.ollama_id, existingModels);

            if (match) {
                match.has_ollama = true;
                match.ollama_id = ollama.ollama_id;
                match.ollama_pulls = ollama.pulls || 0;

                // Safely update meta_json
                let meta = {};
                try {
                    meta = typeof match.meta_json === 'string'
                        ? JSON.parse(match.meta_json || '{}')
                        : (match.meta_json || {});
                } catch (e) {
                    meta = {};
                }

                meta.ollama = {
                    id: ollama.ollama_id,
                    url: ollama.source_url,
                    pulls: ollama.pulls,
                    details: ollama.details || null,
                    parameters: ollama.parameters || null
                };
                match.meta_json = JSON.stringify(meta);

                // Inject modelfile into body_content if present
                if (ollama.modelfile) {
                    match.body_content = match.body_content || '';
                    if (!match.body_content.includes('## Deploy with Ollama')) {
                        match.body_content += `\n\n## Deploy with Ollama\n\`\`\`dockerfile\n${ollama.modelfile}\n\`\`\`\n`;
                    }
                }

                enriched++;
            } else {
                notMatched.push(ollama.ollama_id);
            }
        }

        console.log(`[Ollama] Enriched ${enriched} models`);
        if (notMatched.length > 0) {
            console.log(`[Ollama] Not matched: ${notMatched.slice(0, 10).join(', ')}${notMatched.length > 10 ? '...' : ''}`);
        }

        return existingModels;
    }

    /**
     * Get Ollama badge info for a model
     */
    static getOllamaBadge(model) {
        if (!model.has_ollama) return null;

        return {
            label: 'Ollama',
            command: `ollama run ${model.ollama_id}`,
            url: `https://ollama.com/library/${model.ollama_id}`,
            icon: '🦙'
        };
    }
}

export default OllamaAdapter;
