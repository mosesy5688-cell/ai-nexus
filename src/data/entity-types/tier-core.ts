/**
 * Entity Types - Tier 1: Core
 * V5.2 - Split from entity-definitions.ts for growth management
 */

import type { EntityDefinition } from '../../types/entity-schema';

export const TIER_CORE_ENTITIES: Record<string, EntityDefinition> = {
    model: {
        type: 'model',
        schema: 'entity.v1',
        idPrefix: 'hf-model--',
        seoType: 'SoftwareApplication',
        tier: 'core',
        capabilities: ['fni', 'deploy', 'benchmark', 'architecture', 'ollama', 'gguf'],
        modules: [
            'FNIModule',
            'DeployModule',
            'BenchmarkModule',
            'ArchitectureModule',
            'OllamaModule',
            'GGUFModule',
        ],
        requiredFields: ['name', 'author', 'source'],
        display: {
            icon: '🧠',
            color: 'blue',
            labelSingular: 'Model',
            labelPlural: 'Models',
        },
    },
};
