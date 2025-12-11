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
 * @module ingestion/adapters/deepspec-adapter
 */

import { BaseAdapter } from './base-adapter.js';

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
     * Fetch deep specs for models from HuggingFace
     * @param {Object} options
     * @param {string[]} options.modelIds - Specific model IDs to fetch
     * @param {number} options.limit - Maximum models to process
     */
    async fetch(options = {}) {
        const { modelIds = [], limit = 100 } = options;

        console.log(`📥 [DeepSpec] Fetching model specifications...`);

        try {
            let modelsToProcess = modelIds;

            // If no specific models, fetch top models from HF Hub
            if (modelsToProcess.length === 0) {
                console.log(`   Fetching top ${limit} text-generation models...`);
                const hubResponse = await fetch(
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

            // Extract specs for each model
            const specs = [];
            for (const modelId of modelsToProcess.slice(0, limit)) {
                const spec = await this.extractSpec(modelId);
                if (spec) {
                    specs.push(spec);
                    console.log(`   ✅ ${modelId}: ${spec.params_billions}B, ctx=${spec.context_length}, arch=${spec.architecture_family}`);
                }

                // Rate limiting - V4.3.2 Constitution
                await this.delay(300);
            }

            console.log(`   📊 Extracted ${specs.length}/${modelsToProcess.length} model specs`);

            return specs;

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
            const configUrl = `https://huggingface.co/${modelId}/raw/main/config.json`;
            const response = await fetch(configUrl, {
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Free2AITools/1.0'
                }
            });

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
