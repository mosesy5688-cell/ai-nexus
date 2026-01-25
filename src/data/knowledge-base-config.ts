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
    {
        id: 'organizations',
        title: 'Organizations',
        icon: '🏢',
        description: 'Leading entities in the AI ecosystem',
        articles: [
            { slug: 'meta', title: 'Meta AI', description: 'Creators of Llama and pioneers of open-weights research', difficulty: 'Beginner', effort: '3 min' },
            { slug: 'google', title: 'Google DeepMind', description: 'Pioneers of Transformers and Gemini', difficulty: 'Beginner', effort: '4 min' },
            { slug: 'openai', title: 'OpenAI', description: 'Creators of GPT-4 and ChatGPT ecosystem', difficulty: 'Beginner', effort: '5 min' },
            { slug: 'mistral-ai', title: 'Mistral AI', description: 'European leader in efficient MoE models', difficulty: 'Beginner', effort: '3 min' }
        ]
    },
    {
        id: 'benchmarks',
        title: 'Benchmarks',
        icon: '📊',
        description: 'Understanding AI model evaluation metrics',
        articles: [
            { slug: 'what-is-mmlu', title: 'What is MMLU?', description: 'Massive Multitask Language Understanding benchmark explained', difficulty: 'Intermediate', effort: '5 min' },
            { slug: 'what-is-humaneval', title: 'What is HumanEval?', description: 'Code generation benchmark for evaluating programming ability', difficulty: 'Intermediate', effort: '4 min' },
            { slug: 'what-is-hellaswag', title: 'What is HellaSwag?', description: 'Commonsense reasoning benchmark explained', difficulty: 'Intermediate', effort: '3 min' },
            { slug: 'what-is-arc', title: 'What is ARC?', description: 'AI2 Reasoning Challenge for grade-school science questions', difficulty: 'Intermediate', effort: '4 min' }
        ]
    },
    {
        id: 'architecture',
        title: 'Model Architecture',
        icon: '🏗️',
        description: 'Technical concepts behind AI models',
        articles: [
            { slug: 'what-is-context-length', title: 'What is Context Length?', description: 'Understanding token windows and memory in LLMs', difficulty: 'Beginner', effort: '3 min' },
            { slug: 'what-is-parameters', title: 'What are Model Parameters?', description: 'Why 7B, 70B, and model size matters', difficulty: 'Beginner', effort: '4 min' },
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
    {
        id: 'families',
        title: 'Model Families',
        icon: '🦙',
        description: 'Guide to major AI model families',
        articles: [
            { slug: 'llama-family-guide', title: 'Llama Family Guide', description: "Meta's LLaMA series from 7B to 70B", difficulty: 'Beginner', effort: '5 min' },
            { slug: 'qwen-family-guide', title: 'Qwen Family Guide', description: "Alibaba's Qwen series and capabilities", difficulty: 'Beginner', effort: '5 min' },
            { slug: 'mistral-family-guide', title: 'Mistral Family Guide', description: "Mistral AI's efficient model lineup", difficulty: 'Beginner', effort: '5 min' }
        ]
    },
    {
        id: 'deployment',
        title: 'Local Deployment',
        icon: '⚡',
        description: 'Running AI models on your own hardware',
        articles: [
            { slug: 'how-to-run-locally', title: 'How to Run LLMs Locally', description: 'Complete guide to running models on your machine', difficulty: 'Intermediate', effort: '8 min' },
            { slug: 'what-is-gguf', title: 'What is GGUF?', description: 'Quantized model formats for efficient local inference', difficulty: 'Advanced', effort: '6 min' },
            { slug: 'what-is-ollama', title: 'What is Ollama?', description: 'Easy local LLM deployment tool explained', difficulty: 'Beginner', effort: '3 min' }
        ]
    },
    {
        id: 'metrics',
        title: 'Platform Metrics',
        icon: '📈',
        description: 'Understanding Free2AITools metrics',
        articles: [
            { slug: 'what-is-fni', title: 'What is FNI?', description: 'Fair Nexus Index - our model trust score explained', difficulty: 'Beginner', effort: '2 min' },
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
            { slug: 'fundamentals', title: 'AI Fundamentals', description: 'Core concepts and architectures', difficulty: 'Beginner', effort: '5 min' },
            { slug: 'llm-benchmarks', title: 'LLM Evaluation', description: 'How model performance is measured', difficulty: 'Intermediate', effort: '5 min' },
            { slug: 'large-language-model', title: 'Large Language Model (LLM)', description: 'Foundational concept of modern AI systems', difficulty: 'Beginner', effort: '5 min' }
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
    const aliasMap: Record<string, string> = {
        'mmlu': 'what-is-mmlu',
        'fni': 'what-is-fni',
        'humaneval': 'what-is-humaneval',
        'context-length': 'what-is-context-length',
        'deploy-score': 'what-is-deploy-score',
        'gguf': 'what-is-gguf',
        'vram': 'vram',
        'ollama': 'what-is-ollama',
        'llm': 'large-language-model',
        'transformer': 'transformer',
        'what-is-transformer': 'transformer',
        'moe': 'moe',
        'what-is-moe': 'moe',
        'meta-ai': 'meta'
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
