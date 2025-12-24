/**
 * HuggingFace Utility Functions
 * 
 * B.1 CES Refactor: Extracted from huggingface-adapter.js
 * Contains helper methods for model processing
 * 
 * @module ingestion/adapters/hf-utils
 */

/**
 * Parse model ID into author and name
 * @param {string} modelId - Model identifier (e.g., "meta-llama/Llama-3")
 * @returns {[string, string]} [author, name]
 */
export function parseModelId(modelId) {
    const parts = (modelId || '').split('/');
    if (parts.length >= 2) {
        return [parts[0], parts.slice(1).join('-')];
    }
    return ['unknown', modelId || 'unknown'];
}

/**
 * Infer entity type from raw HuggingFace data
 * @param {Object} raw - Raw model data from HuggingFace API
 * @returns {string} Entity type: 'model', 'dataset', or 'tool'
 */
export function inferType(raw) {
    const pipelineTag = raw.pipeline_tag || '';

    // Dataset indicators
    if (raw.cardData?.datasets || pipelineTag === 'dataset') {
        return 'dataset';
    }

    // Tool/library indicators
    if (raw.library_name === 'transformers' && !pipelineTag) {
        return 'tool';
    }

    return 'model';
}

/**
 * Normalize tags array
 * @param {any} tags - Raw tags from API
 * @returns {string[]} Normalized tags array
 */
export function normalizeTags(tags) {
    if (!Array.isArray(tags)) return [];
    return tags
        .filter(t => typeof t === 'string')
        .map(t => t.toLowerCase().trim())
        .filter(t => t.length > 0 && t.length < 50);
}

/**
 * Build metadata JSON from raw model data
 * @param {Object} raw - Raw model data
 * @returns {Object} Metadata object
 */
export function buildMetaJson(raw) {
    const config = raw.config || {};

    // Extract params (safetensors.total or config)
    const paramsRaw = raw.safetensors?.total || config.num_parameters || null;
    const paramsBillions = paramsRaw ? (paramsRaw / 1e9).toFixed(2) : null;

    // Extract context length from various config fields
    const contextLength = config.max_position_embeddings ||
        config.max_seq_len ||
        config.n_positions ||
        config.max_sequence_length ||
        config.seq_length ||
        null;

    // Extract architecture from config
    const architectures = config.architectures || [];
    const architecture = architectures[0] || config.model_type || null;

    return {
        // Basic info
        pipeline_tag: raw.pipeline_tag || null,
        library_name: raw.library_name || null,
        framework: raw.library_name || null,

        // Technical specs (P2 fix)
        params: paramsRaw,
        params_billions: paramsBillions ? parseFloat(paramsBillions) : null,
        context_length: contextLength,
        architecture: architecture,

        // Model architecture details
        hidden_size: config.hidden_size || config.d_model || null,
        num_layers: config.num_hidden_layers || config.n_layer || null,
        num_attention_heads: config.num_attention_heads || config.n_head || null,
        vocab_size: config.vocab_size || null,

        // Storage info
        storage_bytes: raw.usedStorage || null,
        files_count: raw.siblings?.length || 0,
        spaces_count: raw.spaces?.length || 0,

        // Access info
        gated: raw.gated || false,
        private: raw.private || false,

        // Full config for reference
        config: config
    };
}


/**
 * Detect GGUF files in model repository
 * V3.3 Data Expansion - "Runtime First" Strategy
 * @param {Object} raw - Raw model data
 * @returns {Object} { hasGGUF: boolean, variants: string[] }
 */
export function detectGGUF(raw) {
    const siblings = raw.siblings || [];
    const ggufFiles = siblings.filter(f =>
        f.rfilename && f.rfilename.toLowerCase().endsWith('.gguf')
    );

    if (ggufFiles.length === 0) {
        return { hasGGUF: false, variants: [] };
    }

    // Extract quantization variants from filenames
    const quantizationPattern = /[_-](Q\d+_[A-Z0-9_]+|f16|f32|int[48])/i;
    const variants = [];

    for (const file of ggufFiles) {
        const match = file.rfilename.match(quantizationPattern);
        if (match) {
            const variant = match[1].toUpperCase();
            if (!variants.includes(variant)) {
                variants.push(variant);
            }
        }
    }

    // Sort variants by quality (higher quantization = better quality)
    const order = ['F32', 'F16', 'Q8_0', 'Q6_K', 'Q5_K_M', 'Q5_K_S', 'Q4_K_M', 'Q4_K_S', 'Q4_0', 'Q3_K_M', 'Q2_K'];
    variants.sort((a, b) => {
        const aIdx = order.indexOf(a);
        const bIdx = order.indexOf(b);
        return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
    });

    return { hasGGUF: true, variants };
}

/**
 * Extract meaningful images from HuggingFace model
 * @param {Object} raw - Raw model data
 * @returns {Object[]} Array of asset objects
 */
export function extractAssets(raw) {
    const assets = [];
    const siblings = raw.siblings || [];

    // Priority 1: Card image (architecture.png, model.png, etc.)
    const cardImages = siblings.filter(f =>
        /^(architecture|model|diagram|overview|logo)\.(webp|png|jpg|jpeg)$/i.test(f.rfilename)
    );
    for (const img of cardImages) {
        assets.push({
            type: 'card_image',
            url: `https://huggingface.co/${raw.modelId}/resolve/main/${img.rfilename}`,
            filename: img.rfilename
        });
    }

    // Priority 2: Images referenced in README
    if (raw.readme && assets.length === 0) {
        const imgPattern = /!\[.*?\]\(((?!http)[^)]+\.(webp|png|jpg|jpeg))\)/gi;
        let match;
        while ((match = imgPattern.exec(raw.readme)) !== null) {
            const filename = match[1];
            if (!filename.includes('..')) {
                assets.push({
                    type: 'readme_image',
                    url: `https://huggingface.co/${raw.modelId}/resolve/main/${filename}`,
                    filename: filename
                });
            }
        }
    }

    // Priority 3: First image from assets folder
    if (assets.length === 0) {
        const firstImage = siblings.find(f =>
            /\.(webp|png|jpg|jpeg)$/i.test(f.rfilename) &&
            f.rfilename.startsWith('assets/')
        );
        if (firstImage) {
            assets.push({
                type: 'fallback_image',
                url: `https://huggingface.co/${raw.modelId}/resolve/main/${firstImage.rfilename}`
            });
        }
    }

    return assets;
}

/**
 * Delay execution for rate limiting
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise<void>}
 */
export function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
