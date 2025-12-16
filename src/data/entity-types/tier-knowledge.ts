/**
 * Entity Types - Tier 3: Knowledge
 * V5.2 - Split from entity-definitions.ts for growth management
 */

import type { EntityDefinition } from '../../types/entity-schema';

export const TIER_KNOWLEDGE_ENTITIES: Record<string, EntityDefinition> = {
    paper: {
        type: 'paper',
        schema: 'entity.v1',
        idPrefix: 'arxiv--',
        seoType: 'ScholarlyArticle',
        tier: 'knowledge',
        capabilities: ['citations'],
        modules: ['CitationsModule'],
        requiredFields: ['title', 'authors', 'abstract', 'arxiv_id'],
        display: {
            icon: '📄',
            color: 'yellow',
            labelSingular: 'Paper',
            labelPlural: 'Papers',
        },
    },

    tutorial: {
        type: 'tutorial',
        schema: 'entity.v1',
        idPrefix: 'tutorial--',
        seoType: 'HowTo',
        tier: 'knowledge',
        capabilities: [],
        modules: [],
        requiredFields: ['title', 'steps', 'difficulty'],
        display: {
            icon: '📚',
            color: 'purple',
            labelSingular: 'Tutorial',
            labelPlural: 'Tutorials',
        },
    },
};
