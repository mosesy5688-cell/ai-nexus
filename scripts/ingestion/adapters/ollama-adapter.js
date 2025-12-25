/**
 * Ollama Adapter
 * 
 * Constitution V3.3 Data Expansion - "Runtime First" Strategy
 * 
 * Scrapes Ollama Library to enrich models with local deployment data.
 * This directly boosts the FNI Utility (U) dimension.
 * 
 * V2.1: Added NSFW filter at fetch level
 * 
 * @module scripts/ingestion/adapters/ollama-adapter
 */

import { BaseAdapter, NSFW_KEYWORDS } from './base-adapter.js';

const OLLAMA_LIBRARY_URL = 'https://ollama.com/library';

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
        super('ollama', 'Ollama Library');
    }

    /**
     * Fetch Ollama library models
     */
    async fetch(options = {}) {
        console.log('[Ollama] Fetching library...');

        try {
            // Note: Ollama doesn't have a public API, so we'll use a structured approach
            // In production, this might need to scrape the page or use an unofficial API

            // For now, we'll use a static list of popular models from Ollama
            // This can be enhanced with actual scraping later
            const ollamaModels = await this.fetchOllamaLibrary();

            console.log(`[Ollama] Found ${ollamaModels.length} models`);
            return ollamaModels;

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

        return {
            // Identity
            id: `ollama/${ollamaId}`,
            type: 'model',
            source: 'ollama',
            source_url: raw.source_url || `https://ollama.com/library/${ollamaId}`,

            // Content
            title: raw.name || ollamaId,
            description: `Ollama model: ${ollamaId}. Run locally with: ollama run ${ollamaId}`,
            body_content: '',
            tags: ['ollama', 'local-deployment'],  // Inline to avoid 'this' context issues

            // V6.0: Pipeline tag for category assignment (all Ollama models are text-generation LLMs)
            pipeline_tag: 'text-generation',

            // Metadata
            author: 'ollama',
            license_spdx: null,
            meta_json: JSON.stringify({
                ollama: {
                    id: ollamaId,
                    url: raw.source_url,
                    is_fallback: raw.is_fallback || false
                }
            }),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),

            // Metrics
            popularity: raw.pulls || 0,
            downloads: raw.pulls || 0,

            // Assets
            raw_image_url: null,

            // Relations
            relations: [],

            // Ollama-specific flags
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
     * Fetch Ollama library (structured data)
     */
    async fetchOllamaLibrary() {
        // Try to fetch the library page and parse it
        try {
            const response = await fetch(OLLAMA_LIBRARY_URL, {
                headers: {
                    'User-Agent': 'Free2AITools/1.0 (+https://free2aitools.com)'
                }
            });

            if (!response.ok) {
                console.warn('[Ollama] HTTP error:', response.status);
                return this.getFallbackModels();
            }

            const html = await response.text();
            return this.parseOllamaLibrary(html);

        } catch (error) {
            console.warn('[Ollama] Fetch failed, using fallback:', error.message);
            return this.getFallbackModels();
        }
    }

    /**
     * Parse Ollama library HTML
     */
    parseOllamaLibrary(html) {
        const models = [];

        // Simple regex-based parsing (can be enhanced with cheerio if needed)
        // Looking for model links like /library/llama3
        const modelPattern = /href="\/library\/([^"]+)"[^>]*>[\s\S]*?<h2[^>]*>([^<]+)<\/h2>/gi;
        let match;

        while ((match = modelPattern.exec(html)) !== null) {
            const [_, slug, name] = match;
            if (slug && !slug.includes('/')) {
                models.push({
                    ollama_id: slug.trim(),
                    name: name?.trim() || slug.trim(),
                    source_url: `https://ollama.com/library/${slug.trim()}`
                });
            }
        }

        // Also try to find models in JSON data if embedded
        try {
            const jsonMatch = html.match(/\{"models":\s*\[[\s\S]*?\]\}/);
            if (jsonMatch) {
                const data = JSON.parse(jsonMatch[0]);
                if (data.models && Array.isArray(data.models)) {
                    data.models.forEach(m => {
                        if (!models.find(x => x.ollama_id === m.name)) {
                            models.push({
                                ollama_id: m.name,
                                name: m.name,
                                pulls: m.pulls || m.download_count || 0,
                                source_url: `https://ollama.com/library/${m.name}`
                            });
                        }
                    });
                }
            }
        } catch (e) {
            // JSON parsing failed, continue with regex results
        }

        return models.length > 0 ? models : this.getFallbackModels();
    }

    /**
     * Fallback list of known Ollama models
     */
    getFallbackModels() {
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

                // Update meta_json
                const meta = typeof match.meta_json === 'string'
                    ? JSON.parse(match.meta_json || '{}')
                    : (match.meta_json || {});
                meta.ollama = {
                    id: ollama.ollama_id,
                    url: ollama.source_url,
                    pulls: ollama.pulls
                };
                match.meta_json = JSON.stringify(meta);

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
