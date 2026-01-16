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
            { slug: 'what-is-transformer', title: 'What is a Transformer?', description: 'The architecture behind modern language models', difficulty: 'Advanced', effort: '10 min' }
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
        title: 'Deployment',
        icon: '⚡',
        description: 'Running and deploying AI models',
        articles: [
            { slug: 'how-to-run-locally', title: 'How to Run LLMs Locally', description: 'Complete guide to running models on your machine', difficulty: 'Intermediate', effort: '8 min' },
            { slug: 'what-is-gguf', title: 'What is GGUF?', description: 'Quantized model formats for efficient inference', difficulty: 'Advanced', effort: '6 min' },
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
            { slug: 'local-inference', title: 'Local Inference', description: 'Running models on your own hardware', difficulty: 'Intermediate', effort: '8 min' }
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
    for (const category of KNOWLEDGE_CATEGORIES) {
        const article = category.articles.find(a => a.slug === slug);
        if (article) return { category, article };
    }
    return null;
}
