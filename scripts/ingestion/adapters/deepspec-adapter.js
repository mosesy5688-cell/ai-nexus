/**
 * HuggingFace Deep Spec Extractor Adapter
 * V4.3.2 Constitution Compliance
 * 
 * Extracts detailed model specifications from HuggingFace config.json files:
 * - params_billions: Estimated parameter count
 * - context_length: Maximum context window
 * - architecture_family: Model architecture family (llama, qwen, mistral, etc.)
 * - deploy_score: Deployability index (0-1)
 * 
 * V2.1: Added NSFW filter at fetch level
 * 
 * @module ingestion/adapters/deepspec-adapter
 */

import { BaseAdapter, NSFW_KEYWORDS } from './base-adapter.js';

// V28: bound the per-model config.json fan-out. Was strictly serial with a 300ms
// delay each (~2000 serial round-trips at limit=2000). Process in windows of
// SPEC_CONCURRENCY via Promise.all with a small inter-window delay (mirrors the
// replicate-adapter N+1 fix) so we stay polite without serializing.
const SPEC_CONCURRENCY = 8;
const SPEC_WINDOW_DELAY_MS = 300;

// Architecture family patterns
const ARCHITECTURE_FAMILIES = {
    'llama': ['llama', 'vicuna', 'alpaca', 'wizardlm', 'openorca'],
    'qwen': ['qwen'],
    'mistral': ['mistral', 'mixtral', 'zephyr'],
    'gemma': ['gemma'],
    'phi': ['phi'],
    'falcon': ['falcon'],
    'mamba': ['mamba', 'state-space'],
    'rwkv': ['rwkv'],
    'gpt': ['gpt', 'gpt2', 'gpt-neo', 'gpt-j'],
    'bloom': ['bloom', 'bloomz'],
    'opt': ['opt'],
    'deepseek': ['deepseek'],
    'yi': ['yi-'],
    'internlm': ['internlm'],
    'baichuan': ['baichuan'],
    'chatglm': ['chatglm', 'glm'],
    'command': ['command-r', 'c4ai'],
    'stable': ['stablelm', 'stable-'],
};

// Common architecture types from config.json
const ARCH_TYPE_MAP = {
    'LlamaForCausalLM': 'llama',
    'Qwen2ForCausalLM': 'qwen',
    'MistralForCausalLM': 'mistral',
    'MixtralForCausalLM': 'mistral',
    'GemmaForCausalLM': 'gemma',
    'Gemma2ForCausalLM': 'gemma',
    'PhiForCausalLM': 'phi',
    'Phi3ForCausalLM': 'phi',
    'FalconForCausalLM': 'falcon',
    'MambaForCausalLM': 'mamba',
    'RwkvForCausalLM': 'rwkv',
    'GPT2LMHeadModel': 'gpt',
    'GPTNeoForCausalLM': 'gpt',
    'GPTJForCausalLM': 'gpt',
    'BloomForCausalLM': 'bloom',
    'OPTForCausalLM': 'opt',
    'DeepseekV2ForCausalLM': 'deepseek',
    'InternLM2ForCausalLM': 'internlm',
    'BaichuanForCausalLM': 'baichuan',
    'ChatGLMForConditionalGeneration': 'chatglm',
    'StableLmForCausalLM': 'stable',
    'CohereForCausalLM': 'command',
};

export class DeepSpecAdapter extends BaseAdapter {
    constructor() {
        super('huggingface_deepspec');
    }

    /**
     * Rate limiting delay helper - V4.3.2 Constitution
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Normalize raw spec to UnifiedEntity format
     * Required by BaseAdapter abstract method
     * @param {Object} raw - Raw spec from extractSpec()
     * @returns {Object} UnifiedEntity
     */
    normalize(raw) {
        if (!raw || !raw.model_id) return null;

        const [author, ...nameParts] = raw.model_id.split('/');
        const name = nameParts.join('/') || author;

        // V28 honest-contract: build the displayed spec line from only the fields
        // we actually extracted, omitting missing ones rather than presenting a
        // fabricated `?B parameters` / `? context length` AS data. (architecture_family
        // may legitimately be the string 'unknown' returned by detectArchitectureFamily
        // — that is an honest detector sentinel, kept as-is when present.) The
        // structured meta_json below still stores the true null for any missing field.
        const specParts = [];
        if (raw.params_billions) specParts.push(`${raw.params_billions}B parameters`);
        if (raw.context_length) specParts.push(`${raw.context_length} context length`);
        if (raw.architecture_family) specParts.push(`${raw.architecture_family} architecture`);
        const specLine = specParts.join(', ');
        const description = specLine || 'Model specifications unavailable';

        return {
            id: this.generateId(author, name),
            type: 'model',
            source: 'huggingface_deepspec',
            source_url: `https://huggingface.co/${raw.model_id}`,
            title: name,
            description,
            body_content: specLine ? `${name}: ${specLine}.` : `${name}.`,
            tags: [raw.architecture_family, raw.params_billions ? `${raw.params_billions}B` : null, 'text-generation'].filter(Boolean),
            author: author || 'unknown',
            license_spdx: null,
            meta_json: {
                params_billions: raw.params_billions,
                context_length: raw.context_length,
                architecture_family: raw.architecture_family,
                deploy_score: raw.deploy_score,
                vocab_size: raw.vocab_size,
                hidden_size: raw.hidden_size,
                num_layers: raw.num_layers
            },
            popularity: 0,
            raw_image_url: null,
            relations: [],
            content_hash: this.generateContentHash({ title: raw.model_id, description: raw.architecture_family }),
            compliance_status: 'approved',
            quality_score: this.calculateQualityScore({ body_content: '', popularity: 0 })
        };
    }

    /**
     * Fetch deep specs for models from HuggingFace
     * @param {Object} options
     * @param {string[]} options.modelIds - Specific model IDs to fetch
     * @param {number} options.limit - Maximum models to process
     */
    async fetch(options = {}) {
        const { modelIds = [], limit = 2000, onBatch } = options;

        console.log(`📥 [DeepSpec] Fetching model specifications (onBatch: ${!!onBatch})...`);

        try {
            let modelsToProcess = modelIds;

            // If no specific models, fetch top models from HF Hub
            if (modelsToProcess.length === 0) {
                console.log(`   Fetching top ${limit} text-generation models...`);
                // V28: wrap in fetchWithTimeout (was a bare fetch with NO timeout).
                const hubResponse = await this.fetchWithTimeout(
                    `https://huggingface.co/api/models?sort=downloads&direction=-1&limit=${limit}&filter=text-generation`,
                    {
                        headers: {
                            'Accept': 'application/json',
                            'User-Agent': 'Free2AITools/1.0'
                        }
                    }
                );

                if (!hubResponse.ok) {
                    console.warn(`   ⚠️ Hub API returned ${hubResponse.status}`);
                    return [];
                }

                const models = await hubResponse.json();
                modelsToProcess = models.map(m => m.id || m.modelId);
                console.log(`   📦 Got ${modelsToProcess.length} models to process`);
            }

            // Extract specs for each model.
            // V28: bound-concurrency windows (was strictly serial with 300ms each).
            // Each window of SPEC_CONCURRENCY models runs its config.json fetches in
            // parallel; a SPEC_WINDOW_DELAY_MS pause between windows preserves polite
            // pacing. onBatch flushing (batch of 20) is unchanged in semantics.
            const specs = [];
            const batchSize = 20;
            let currentBatch = [];
            const targets = modelsToProcess.slice(0, limit);

            for (let i = 0; i < targets.length; i += SPEC_CONCURRENCY) {
                const window = targets.slice(i, i + SPEC_CONCURRENCY);
                const windowSpecs = await Promise.all(window.map((modelId) => this.extractSpec(modelId)));

                for (const spec of windowSpecs) {
                    if (!spec) continue;
                    if (onBatch) {
                        currentBatch.push(spec);
                        if (currentBatch.length >= batchSize) {
                            await onBatch(currentBatch);
                            currentBatch = [];
                        }
                    } else {
                        specs.push(spec);
                    }
                    console.log(`   ✅ ${spec.model_id}: ${spec.params_billions}B, ctx=${spec.context_length}, arch=${spec.architecture_family}`);
                }

                // Rate limiting between windows - V4.3.2 Constitution (polite pacing)
                if (i + SPEC_CONCURRENCY < targets.length) await this.delay(SPEC_WINDOW_DELAY_MS);
            }

            // Final batch
            if (onBatch && currentBatch.length > 0) {
                await onBatch(currentBatch);
            }

            console.log(`   📊 Extracted ${onBatch ? 'Streaming' : specs.length}/${modelsToProcess.length} model specs`);

            return onBatch ? [] : specs;

        } catch (error) {
            console.error(`   ❌ Fetch error: ${error.message}`);
            return [];
        }
    }

    /**
     * Extract specification from a single model's config.json
     * @param {string} modelId - HuggingFace model ID
     * @returns {Object|null} Model spec or null if unavailable
     */
    async extractSpec(modelId) {
        try {
            // Fetch config.json
            // V28: wrap in fetchWithTimeout (was a bare fetch with NO timeout — a
            // single hung config.json could stall a whole concurrency window). 15s
            // per-file abort window; on timeout/error returns null (honest: the
            // model is simply skipped, no fabricated spec).
            const configUrl = `https://huggingface.co/${modelId}/raw/main/config.json`;
            const response = await this.fetchWithTimeout(configUrl, {
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Free2AITools/1.0'
                }
            }, 15000);

            if (!response.ok) {
                return null;
            }

            const config = await response.json();

            // Extract architecture family
            const architectureFamily = this.detectArchitectureFamily(modelId, config);

            // Estimate parameters
            const paramsBillions = this.estimateParams(config, architectureFamily);

            // Extract context length
            const contextLength = this.extractContextLength(config);

            // Calculate deploy score (V4.3.2)
            const deployScore = this.calculateDeployScore({
                paramsBillions,
                contextLength,
                hasGguf: false, // Would need to check files
                existsInOllama: false // Would need to check Ollama registry
            });

            return {
                model_id: modelId,
                normalized_name: this.normalizeModelName(modelId),
                params_billions: paramsBillions,
                context_length: contextLength,
                vocab_size: config.vocab_size || null,
                hidden_size: config.hidden_size || config.d_model || null,
                num_layers: config.num_hidden_layers || config.n_layer || config.num_layers || null,
                architecture: config.architectures?.[0] || config.model_type || null,
                architecture_family: architectureFamily,
                base_model_umid: null, // To be resolved by L3
                quantization_formats: null, // Would need to check files
                config_json: JSON.stringify(config),
                deploy_score: deployScore,
                source: 'huggingface_config'
            };

        } catch (error) {
            return null;
        }
    }

    /**
     * Detect architecture family from model ID and config
     * @param {string} modelId 
     * @param {Object} config 
     * @returns {string|null}
     */
    detectArchitectureFamily(modelId, config) {
        // First try from architectures field
        const archType = config.architectures?.[0];
        if (archType && ARCH_TYPE_MAP[archType]) {
            return ARCH_TYPE_MAP[archType];
        }

        // Try from model_type
        const modelType = (config.model_type || '').toLowerCase();
        for (const [family, patterns] of Object.entries(ARCHITECTURE_FAMILIES)) {
            if (patterns.some(p => modelType.includes(p))) {
                return family;
            }
        }

        // Try from model ID
        const modelIdLower = modelId.toLowerCase();
        for (const [family, patterns] of Object.entries(ARCHITECTURE_FAMILIES)) {
            if (patterns.some(p => modelIdLower.includes(p))) {
                return family;
            }
        }

        return config.model_type || 'unknown';
    }

    /**
     * Estimate parameter count from config
     * V4.3.2: Handles Mamba, RWKV, MoE special cases
     * @param {Object} config 
     * @param {string} archFamily 
     * @returns {number|null}
     */
    estimateParams(config, archFamily) {
        // Check if params are directly available
        if (config.num_parameters) {
            return Math.round(config.num_parameters / 1e9 * 10) / 10;
        }

        const hidden = config.hidden_size || config.d_model || 0;
        const layers = config.num_hidden_layers || config.n_layer || config.num_layers || 0;
        const vocab = config.vocab_size || 32000;
        const intermediate = config.intermediate_size || hidden * 4;

        if (!hidden || !layers) return null;

        let estimated = 0;

        // V4.3.2: Special handling for different architectures
        if (archFamily === 'mamba') {
            // Mamba: state-space model estimation
            const dState = config.d_state || 16;
            const dConv = config.d_conv || 4;
            estimated = layers * hidden * (2 * hidden + dState * dConv) + vocab * hidden;
        } else if (archFamily === 'rwkv') {
            // RWKV: RNN-like estimation
            estimated = layers * (4 * hidden * hidden + hidden * vocab / layers);
        } else if (config.num_experts) {
            // MoE: Mixture of Experts
            const numExperts = config.num_experts || 8;
            const topK = config.num_experts_per_tok || 2;
            estimated = layers * (hidden * hidden * 4 + numExperts * hidden * intermediate / topK) + vocab * hidden;
        } else {
            // Standard Transformer
            estimated = (
                // Attention: 4 * hidden^2 per layer
                layers * 4 * hidden * hidden +
                // FFN: 2 * hidden * intermediate per layer
                layers * 2 * hidden * intermediate +
                // Embeddings
                vocab * hidden +
                // Layer norms and biases (small contribution)
                layers * 4 * hidden
            );
        }

        return Math.round(estimated / 1e9 * 10) / 10;
    }

    /**
     * Extract context length from config
     * @param {Object} config 
     * @returns {number|null}
     */
    extractContextLength(config) {
        return (
            config.max_position_embeddings ||
            config.max_sequence_length ||
            config.n_positions ||
            config.seq_length ||
            config.sliding_window || // For Mistral-style
            config.max_seq_len ||
            null
        );
    }

    /**
     * Calculate deployability score - V4.3.2 Constitution
     * @param {Object} specs 
     * @returns {number}
     */
    calculateDeployScore(specs) {
        let score = 0;

        // GGUF availability (+0.4)
        if (specs.hasGguf) score += 0.4;

        // Context length (+0.1 or +0.2)
        if (specs.contextLength > 8192) {
            score += 0.2;
        } else if (specs.contextLength > 0) {
            score += 0.1;
        }

        // Model size - smaller is more deployable (+0.1 or +0.2)
        if (specs.paramsBillions && specs.paramsBillions < 10) {
            score += 0.2;
        } else if (specs.paramsBillions && specs.paramsBillions < 40) {
            score += 0.1;
        }

        // Ollama availability (+0.2)
        if (specs.existsInOllama) score += 0.2;

        return Math.min(score, 1.0);
    }

    /**
     * Normalize model name for matching
     * @param {string} modelId 
     * @returns {string}
     */
    normalizeModelName(modelId) {
        return modelId
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
    }
}

export default DeepSpecAdapter;
