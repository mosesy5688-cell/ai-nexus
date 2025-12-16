/**
 * Ranking Category Definitions
 * V4.9.1 Step 3 Traffic Amplifiers - SEO-friendly metadata
 */

export interface CategoryConfig {
    title: string;
    description: string;
    pipeline_tag: string;
    seoTitle: string;
    seoContent: string;
}

export const RANKING_CATEGORIES: Record<string, CategoryConfig> = {
    'text-generation': {
        title: 'Text Generation Models',
        description: 'LLMs and language models for text generation, chat, and completion.',
        pipeline_tag: 'text-generation',
        seoTitle: 'Best Text Generation AI Models 2024 - LLM Rankings',
        seoContent: 'Text generation models (LLMs) are the foundation of modern AI assistants. These models can write, summarize, translate, and reason about text. Popular architectures include GPT, LLaMA, Qwen, and Mistral.'
    },
    'code': {
        title: 'Code Generation Models',
        description: 'AI models specialized in code completion, generation, and assistance.',
        pipeline_tag: 'text-generation',
        seoTitle: 'Best AI Coding Assistants 2024 - Code Model Rankings',
        seoContent: 'Code generation models help developers write, debug, and understand code. These AI assistants can complete code, explain functions, and even generate entire applications. Top models include CodeLlama, DeepSeek Coder, and StarCoder.'
    },
    'embedding': {
        title: 'Embedding Models',
        description: 'Vector embedding models for semantic search, RAG, and similarity.',
        pipeline_tag: 'feature-extraction',
        seoTitle: 'Best Embedding Models 2024 - Vector Search Rankings',
        seoContent: 'Embedding models convert text into numerical vectors, enabling semantic search, RAG systems, and similarity comparisons. They\'re essential for building AI-powered search and retrieval systems.'
    },
    'image': {
        title: 'Image Generation Models',
        description: 'Text-to-image and image generation AI models.',
        pipeline_tag: 'text-to-image',
        seoTitle: 'Best AI Image Generators 2024 - Text-to-Image Rankings',
        seoContent: 'Image generation models create stunning visuals from text prompts. From photorealistic images to artistic styles, these models have revolutionized digital art and design.'
    },
    'vision': {
        title: 'Vision & Multimodal Models',
        description: 'Image understanding, vision-language, and multimodal AI models.',
        pipeline_tag: 'image-text-to-text',
        seoTitle: 'Best Vision AI Models 2024 - Multimodal Rankings',
        seoContent: 'Vision and multimodal models can understand images, answer questions about visuals, and combine text and image understanding. They power applications from document analysis to visual assistants.'
    },
    'audio': {
        title: 'Audio & Speech Models',
        description: 'Speech recognition, text-to-speech, and audio processing models.',
        pipeline_tag: 'automatic-speech-recognition',
        seoTitle: 'Best Speech AI Models 2024 - Audio Model Rankings',
        seoContent: 'Audio AI models handle speech recognition, text-to-speech synthesis, and audio processing. They enable voice assistants, transcription services, and audio content creation.'
    }
};

export function getCategoryConfig(slug: string): CategoryConfig | null {
    return RANKING_CATEGORIES[slug] || null;
}
