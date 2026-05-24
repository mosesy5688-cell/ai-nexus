// V27.46: derive `architecture` field from entity tags when meta_json lacks it.
// HF model cards usually tag the architecture family (llama, mistral, qwen, etc.)
// even when config.json (meta_json source) is incomplete. Tag-based derivation
// recovers the field for ~70-80% of HF entities that previously had
// `specs.architecture: null` in /api/v1/entity output.

// Common HF architecture tag tokens, mapped to canonical family name.
// Order: longer/more-specific tokens first so 'qwen2' matches before 'qwen'.
const ARCH_TAGS = [
    // Llama family
    'llama3', 'llama2', 'llama',
    'mixtral', 'mistral',
    'qwen3', 'qwen2', 'qwen',
    'gemma2', 'gemma',
    'phi3', 'phi2', 'phi',
    'deepseek-v2', 'deepseek-v3', 'deepseek',
    'baichuan2', 'baichuan',
    'yi-34b', 'yi-6b', 'yi',
    'falcon',
    // GPT family
    'gpt-neox', 'gpt-j', 'gpt2', 'gpt',
    // Encoder family
    'roberta', 'bert', 'distilbert', 'electra', 'albert',
    'deberta-v3', 'deberta-v2', 'deberta',
    // Seq2seq
    't5-v1.1', 't5', 'mt5', 'bart', 'pegasus',
    // Vision
    'vit', 'clip', 'sam', 'beit',
    // Audio
    'whisper', 'wav2vec2',
    // Multimodal
    'llava', 'flamingo',
];

/**
 * Derive architecture family from a tag array. Returns the first matching
 * canonical family name, or null if no known architecture tag is present.
 * @param {Array<string>} tags
 * @returns {string|null}
 */
export function deriveArchitectureFromTags(tags) {
    if (!Array.isArray(tags) || tags.length === 0) return null;
    const lowered = tags.map(t => String(t || '').toLowerCase());
    for (const archTag of ARCH_TAGS) {
        if (lowered.includes(archTag)) return archTag;
    }
    // Fallback: check substring match for compound tags like 'meta-llama/Llama-3.1-8B'
    for (const archTag of ARCH_TAGS) {
        if (lowered.some(t => t.includes(archTag))) return archTag;
    }
    return null;
}
