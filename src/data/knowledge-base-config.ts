/**
 * Knowledge Base Configuration
 * V5.2 - Extracted for maintainability (growth-prone file)
 */

export interface KnowledgeArticle {
    slug: string;
    title: string;
    description: string;
    difficulty?: 'Beginner' | 'Intermediate' | 'Advanced';
    effort?: string;
}

export interface KnowledgeCategory {
    id: string;
    title: string;
    icon: string;
    description: string;
    articles: KnowledgeArticle[];
}

export const KNOWLEDGE_CATEGORIES: KnowledgeCategory[] = [
    // V27.33: 'organizations' category removed — all 4 articles (meta, google, openai, mistral-ai)
    // were stub-only (no .md, only createStub placeholder content), triggering CF Worker 503/1102.
    {
        id: 'benchmarks',
        title: 'Benchmarks',
        icon: '📊',
        description: 'Understanding AI model evaluation metrics',
        articles: [
            { slug: 'what-is-mmlu', title: 'What is MMLU?', description: 'Massive Multitask Language Understanding benchmark explained', difficulty: 'Intermediate', effort: '5 min' },
            { slug: 'what-is-humaneval', title: 'What is HumanEval?', description: 'Code generation benchmark for evaluating programming ability', difficulty: 'Intermediate', effort: '4 min' }
            // V27.33: what-is-hellaswag, what-is-arc removed — stub-only (no real content)
        ]
    },
    {
        id: 'architecture',
        title: 'Model Architecture',
        icon: '🏗️',
        description: 'Technical concepts behind AI models',
        articles: [
            { slug: 'what-is-context-length', title: 'What is Context Length?', description: 'Understanding token windows and memory in LLMs', difficulty: 'Beginner', effort: '3 min' },
            // V27.33: what-is-parameters removed — stub-only (no real content)
            { slug: 'rag', title: 'What is RAG?', description: 'Retrieval Augmented Generation for knowledge-grounded AI', difficulty: 'Intermediate', effort: '6 min' }
        ]
    },
    {
        id: 'training',
        title: 'Training & Alignment',
        icon: '🧪',
        description: 'Fine-tuning and aligning AI models',
        articles: [
            { slug: 'lora', title: 'What is LoRA?', description: 'Low-Rank Adaptation for efficient fine-tuning', difficulty: 'Intermediate', effort: '5 min' },
            { slug: 'rlhf', title: 'What is RLHF?', description: 'Reinforcement Learning from Human Feedback', difficulty: 'Advanced', effort: '6 min' },
            { slug: 'dpo', title: 'What is DPO?', description: 'Direct Preference Optimization - simpler RLHF', difficulty: 'Intermediate', effort: '4 min' },
            { slug: 'tokenization', title: 'What is Tokenization?', description: 'How models process text into discrete units', difficulty: 'Beginner', effort: '4 min' }
        ]
    },
    {
        id: 'inference_tech',
        title: 'Inference & Optimization',
        icon: '🚀',
        description: 'Accelerating AI performance and deployment',
        articles: [
            { slug: 'flash-attention', title: 'What is Flash Attention?', description: 'Modern attention optimization for speed', difficulty: 'Advanced', effort: '5 min' },
            { slug: 'kv-cache', title: 'What is KV Cache?', description: 'Memory optimization for token generation', difficulty: 'Advanced', effort: '5 min' },
            { slug: 'speculative-decoding', title: 'Speculative Decoding', description: 'Using draft models to accelerate inference', difficulty: 'Advanced', effort: '6 min' },
            { slug: 'inference-optimization', title: 'Inference Optimization', description: 'Techniques for faster model responses', difficulty: 'Intermediate', effort: '7 min' },
            { slug: 'awq', title: 'What is AWQ?', description: 'Activation-aware Weight Quantization', difficulty: 'Intermediate', effort: '4 min' }
        ]
    },
    {
        id: 'engineering',
        title: 'AI Engineering',
        icon: '⚙️',
        description: 'Building reliable AI applications',
        articles: [
            { slug: 'chain-of-thought', title: 'Chain of Thought (CoT)', description: 'Improving reasoning with step-by-step thinking', difficulty: 'Intermediate', effort: '5 min' },
            { slug: 'structured-output', title: 'Structured Output', description: 'Generating reliable JSON and schemas', difficulty: 'Intermediate', effort: '6 min' },
            { slug: 'function-calling', title: 'Function Calling', description: 'Enabling LLMs to use external tools', difficulty: 'Intermediate', effort: '7 min' },
            { slug: 'model-merging', title: 'Model Merging', description: 'Combining fine-tuned models effectively', difficulty: 'Intermediate', effort: '6 min' }
        ]
    },
    // V27.33: 'families' category removed — all 3 articles (llama-family-guide,
    // qwen-family-guide, mistral-family-guide) were stub-only.
    {
        id: 'deployment',
        title: 'Local Deployment',
        icon: '⚡',
        description: 'Running AI models on your own hardware',
        articles: [
            // V27.33: how-to-run-locally, what-is-ollama removed — stub-only
            { slug: 'what-is-gguf', title: 'What is GGUF?', description: 'Quantized model formats for efficient local inference', difficulty: 'Advanced', effort: '6 min' }
        ]
    },
    {
        id: 'metrics',
        title: 'Platform Metrics',
        icon: '📈',
        description: 'Understanding Free2AITools metrics',
        articles: [
            { slug: 'what-is-fni', title: 'What is FNI?', description: 'Free2AITools Nexus Index - our model trust score explained', difficulty: 'Beginner', effort: '2 min' },
            { slug: 'what-is-deploy-score', title: 'What is Deploy Score?', description: 'Model deployability measurement explained', difficulty: 'Beginner', effort: '2 min' }
        ]
    },
    {
        id: 'fundamentals',
        title: 'AI Fundamentals',
        icon: '🧠',
        description: 'Core concepts and architectures',
        articles: [
            { slug: 'transformer', title: 'Transformer Architecture', description: 'The architecture behind modern language models', difficulty: 'Advanced', effort: '10 min' },
            { slug: 'moe', title: 'Mixture of Experts (MoE)', description: 'Efficient scaling with conditional computation', difficulty: 'Advanced', effort: '7 min' },
            { slug: 'quantization', title: 'Model Quantization', description: 'GGUF, GPTQ, AWQ formats explained', difficulty: 'Intermediate', effort: '6 min' },
            { slug: 'vram', title: 'VRAM Requirements', description: 'Memory needs for running LLMs', difficulty: 'Intermediate', effort: '4 min' },
            { slug: 'local-inference', title: 'Local Inference Cache', description: 'Running models on your own hardware', difficulty: 'Intermediate', effort: '8 min' },
            { slug: 'multimodal', title: 'Multimodal AI', description: 'Processing text, images, and audio seamlessly', difficulty: 'Intermediate', effort: '6 min' },
            { slug: 'rag', title: 'RAG Systems', description: 'Retrieval Augmented Generation architecture', difficulty: 'Intermediate', effort: '7 min' },
            { slug: 'inference-optimization', title: 'Inference Optimization', description: 'Accelerating AI performance and deployment', difficulty: 'Intermediate', effort: '7 min' },
            // V27.33: fundamentals, large-language-model removed — stub-only
            { slug: 'llm-benchmarks', title: 'LLM Evaluation', description: 'How model performance is measured', difficulty: 'Intermediate', effort: '5 min' }
        ]
    }
];

export function getTotalArticleCount(): number {
    return KNOWLEDGE_CATEGORIES.reduce((sum, cat) => sum + cat.articles.length, 0);
}

export function getCategoryById(id: string): KnowledgeCategory | undefined {
    return KNOWLEDGE_CATEGORIES.find(cat => cat.id === id);
}

export function getArticleBySlug(slug: string): { category: KnowledgeCategory; article: KnowledgeArticle } | null {
    // 1. Direct match in categories
    for (const category of KNOWLEDGE_CATEGORIES) {
        const article = category.articles.find(a => a.slug === slug);
        if (article) return { category, article };
    }

    // 2. Alias match (e.g. 'mmlu' -> 'what-is-mmlu')
    // V27.33: removed aliases pointing to deleted stub-only slugs:
    //   'ollama' → 'what-is-ollama', 'llm' → 'large-language-model', 'meta-ai' → 'meta'
    const aliasMap: Record<string, string> = {
        'mmlu': 'what-is-mmlu',
        'fni': 'what-is-fni',
        'humaneval': 'what-is-humaneval',
        'context-length': 'what-is-context-length',
        'deploy-score': 'what-is-deploy-score',
        'gguf': 'what-is-gguf',
        'vram': 'vram',
        'transformer': 'transformer',
        'what-is-transformer': 'transformer',
        'moe': 'moe',
        'what-is-moe': 'moe'
    };

    const canonicalSlug = aliasMap[slug];
    if (canonicalSlug) {
        for (const category of KNOWLEDGE_CATEGORIES) {
            const article = category.articles.find(a => a.slug === canonicalSlug);
            if (article) return { category, article };
        }
    }

    return null;
}
