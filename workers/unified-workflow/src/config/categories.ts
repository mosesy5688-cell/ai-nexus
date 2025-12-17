/**
 * V6.0 Primary Categories Definition
 * Constitution Annex A.2.1 - FROZEN (No changes without Constitutional amendment)
 * 
 * @see docs/CONSTITUTION_ANNEX_A_V6.md
 */

export const PRIMARY_CATEGORIES = {
    'text-generation': 'Text Generation & Content Creation',
    'knowledge-retrieval': 'Knowledge Retrieval & Data Analysis',
    'vision-multimedia': 'Vision & Multimedia Processing',
    'automation-workflow': 'Automation & Workflow Integration',
    'infrastructure-ops': 'Infrastructure & Optimization',
} as const;

export type CategoryId = keyof typeof PRIMARY_CATEGORIES;
export type CategoryName = typeof PRIMARY_CATEGORIES[CategoryId];

/**
 * Category priority for fallback resolution
 * Higher priority = checked first when multiple tags match
 */
export const CATEGORY_PRIORITY: CategoryId[] = [
    'text-generation',
    'knowledge-retrieval',
    'vision-multimedia',
    'automation-workflow',
    'infrastructure-ops'
];

/**
 * Category display metadata for frontend
 */
export const CATEGORY_META: Record<CategoryId, {
    icon: string;
    description: string;
    color: string;
}> = {
    'text-generation': {
        icon: '💬',
        description: 'ChatGPT alternatives, code assistants, content writing',
        color: '#6366f1' // Indigo
    },
    'knowledge-retrieval': {
        icon: '🔍',
        description: 'RAG, embeddings, document analysis, Q&A systems',
        color: '#10b981' // Emerald
    },
    'vision-multimedia': {
        icon: '🎨',
        description: 'Image generation, video, speech, music synthesis',
        color: '#f59e0b' // Amber
    },
    'automation-workflow': {
        icon: '⚡',
        description: 'Workflow automation, agents, intelligent recommendations',
        color: '#8b5cf6' // Violet
    },
    'infrastructure-ops': {
        icon: '🔧',
        description: 'Fine-tuning, deployment, model optimization',
        color: '#64748b' // Slate
    }
};
