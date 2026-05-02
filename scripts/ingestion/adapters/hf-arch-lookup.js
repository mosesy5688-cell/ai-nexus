/**
 * HuggingFace Architecture → Context Length Lookup
 *
 * Maps HF architecture names (e.g., "GlmMoeDsaForCausalLM") and model_type
 * strings (e.g., "qwen3") to known context window sizes.
 *
 * Two-stage match:
 *   1. Strip HF suffixes (ForCausalLM, ForConditionalGeneration, etc.) +
 *      variant modifiers (Moe, Next, Lite, Flash) → exact key lookup.
 *   2. Family prefix fallback: scan FAMILY_KEYS for known prefix
 *      (longest-first) so Qwen3NextForCausalLM → qwen3 → 32768.
 *
 * Extracted from hf-utils.js (B.1 CES Refactor, 2026-05-02) to keep both
 * files under the 250-line monolith ban.
 */

// prettier-ignore
export const CONTEXT_LENGTH_BY_ARCH = { llama:8192,mistral:32768,mixtral:32768,qwen2:32768,qwen3:32768,gemma:8192,gemma2:8192,phi:2048,phi3:4096,phi4:16384,gpt2:1024,gpt_neox:2048,gpt_bigcode:8192,starcoder2:16384,bert:512,roberta:512,albert:512,deberta:512,distilbert:512,t5:512,bart:1024,mbart:1024,pegasus:1024,falcon:2048,bloom:2048,opt:2048,mpt:2048,'stable-diffusion':77,sdxl:77,flux:77,whisper:448,deepseek:4096,internlm:4096,internlm2:32768,baichuan:4096,yi:4096,chatglm:8192,glm:8192,cohere:8192,'command-r':131072,jamba:262144,nemotron:8192,minimax:32768 };

// Family prefix order — try longer/more-specific first.
// Used by archToFamilyKey when exact key doesn't match.
const FAMILY_KEYS = ['qwen3', 'qwen2', 'qwen', 'gemma2', 'gemma', 'phi4', 'phi3', 'phi', 'starcoder2', 'gpt_bigcode', 'gpt_neox', 'gpt2', 'internlm2', 'internlm', 'chatglm', 'glm', 'llama', 'mistral', 'mixtral', 'deepseek', 'falcon', 'bloom', 'opt', 'mpt', 'whisper', 'cohere', 'baichuan', 'yi', 't5', 'bart', 'mbart', 'pegasus', 'bert', 'roberta', 'albert', 'deberta', 'distilbert', 'flux', 'sdxl', 'jamba', 'nemotron', 'minimax', 'command-r'];

/**
 * Normalize architecture identifier (e.g., "GlmMoeDsaForCausalLM",
 * "Qwen3NextForCausalLM", "gemma4_text") into a family key for
 * CONTEXT_LENGTH_BY_ARCH lookup.
 *
 * @param {string} archOrModelType - Either config.architectures[0] (PascalCase)
 *                                   or config.model_type (snake_case)
 * @returns {string|null} Family key matching CONTEXT_LENGTH_BY_ARCH, or null
 */
export function archToFamilyKey(archOrModelType) {
    if (!archOrModelType || typeof archOrModelType !== 'string') return null;

    const key = archOrModelType.toLowerCase()
        // Strip HF generation-task suffixes (longest first)
        .replace(/forconditionalgeneration$|forsequenceclassification$|fortokenclassification$|forquestionanswering$|forseq2seqlm$|forcausallm$|formaskedlm$|forlm$|model$/g, '')
        // Strip dashes / underscores so "gpt-neox" matches "gpt_neox"
        .replace(/[-_]/g, '')
        // Strip variant modifiers (after suffix strip)
        .replace(/(?:moedsa|moe|next|lite|flash|cascade|fast|tiny|mini|small|large|xl|xxl|deepslim|hslim|h)$/g, '');

    // 1. Exact match against table (try original key with dashes/underscores too)
    if (CONTEXT_LENGTH_BY_ARCH[key]) return key;
    const altKey = archOrModelType.toLowerCase().replace(/-/g, '_');
    if (CONTEXT_LENGTH_BY_ARCH[altKey]) return altKey;
    const altKey2 = archOrModelType.toLowerCase();
    if (CONTEXT_LENGTH_BY_ARCH[altKey2]) return altKey2;

    // 2. Family prefix fallback (longest-first; FAMILY_KEYS is ordered)
    const family = FAMILY_KEYS.find(f => key.startsWith(f.replace(/[-_]/g, '')));
    return family || null;
}

/**
 * Lookup context length for an architecture / model_type.
 * @param {string} archOrModelType
 * @returns {number|null} Context length in tokens, or null if unknown
 */
export function lookupContextLength(archOrModelType) {
    const key = archToFamilyKey(archOrModelType);
    return key ? CONTEXT_LENGTH_BY_ARCH[key] : null;
}
