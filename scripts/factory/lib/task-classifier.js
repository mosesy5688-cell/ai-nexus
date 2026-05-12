/**
 * Task Category Classifier — derives task_categories from HF metadata.
 *
 * Maps pipeline_tag + tags + name to a normalized array of task categories,
 * enabling precise filtering (e.g. "coding model" returns Qwen-Coder, not
 * generic text-gen models).
 */

const TAG_TO_CATEGORY = {
    // Coding
    'code': 'coding', 'coder': 'coding', 'code-generation': 'coding',
    'code-completion': 'coding', 'codegen': 'coding', 'code-llama': 'coding',
    // Chat/Instruction
    'instruct': 'chat', 'chat': 'chat', 'conversational': 'chat',
    'assistant': 'chat', 'rlhf': 'chat',
    // Reasoning
    'reasoning': 'reasoning', 'math': 'reasoning', 'gsm8k': 'reasoning',
    'thinking': 'reasoning', 'o1': 'reasoning',
    // Multimodal
    'vision': 'multimodal', 'multimodal': 'multimodal', 'vlm': 'multimodal',
    'image-text-to-text': 'multimodal', 'visual-question-answering': 'multimodal',
    // Embedding
    'sentence-similarity': 'embedding', 'feature-extraction': 'embedding',
    'embedding': 'embedding', 'rerank': 'embedding',
    // Translation
    'translation': 'translation', 'multilingual': 'translation',
    // Summarization
    'summarization': 'summarization',
    // Speech
    'automatic-speech-recognition': 'speech', 'text-to-speech': 'speech',
    'speech-to-text': 'speech', 'asr': 'speech', 'tts': 'speech',
    // Image generation
    'text-to-image': 'image-generation', 'stable-diffusion': 'image-generation',
    'diffusion': 'image-generation', 'flux': 'image-generation',
    // Image classification/detection
    'image-classification': 'vision', 'object-detection': 'vision',
    'image-segmentation': 'vision', 'depth-estimation': 'vision',
    // Audio
    'text-to-audio': 'audio', 'audio-classification': 'audio',
    // Video
    'text-to-video': 'video', 'video-classification': 'video',
};

const NAME_KEYWORDS = {
    coding: /\b(coder?|codegen|code-?llama|deepseek-?coder|qwen-?coder|starcoder|wizardcoder)\b/i,
    reasoning: /\b(o1|o3|reasoning|qwq|deepseek-?r1|thinking)\b/i,
    multimodal: /\b(vision|vl|llava|cogvlm|qwen-?vl|gemini-?vision)\b/i,
    embedding: /\b(embedd?ing|bge|e5|sentence-transformer)\b/i,
    chat: /\b(chat|instruct|assistant|dpo|orpo)\b/i,
};

/**
 * Derive task_categories array from HF metadata.
 * @param {object} entity - Entity with pipeline_tag, tags, name
 * @returns {string[]} - Sorted unique categories
 */
export function deriveTaskCategories(entity) {
    const categories = new Set();
    const pt = (entity.pipeline_tag || '').toLowerCase();
    const tags = Array.isArray(entity.tags) ? entity.tags : (typeof entity.tags === 'string' ? entity.tags.split(/[,\s]+/) : []);
    const name = entity.name || entity.id || '';

    if (pt && TAG_TO_CATEGORY[pt]) categories.add(TAG_TO_CATEGORY[pt]);

    for (const tag of tags) {
        const t = String(tag).toLowerCase().trim();
        if (TAG_TO_CATEGORY[t]) categories.add(TAG_TO_CATEGORY[t]);
    }

    for (const [cat, regex] of Object.entries(NAME_KEYWORDS)) {
        if (regex.test(name)) categories.add(cat);
    }

    if (categories.size === 0 && pt === 'text-generation') categories.add('chat');

    return [...categories].sort();
}
