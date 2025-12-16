/**
 * Entity Types - Tier 2: Enablers
 * V5.2 - Split from entity-definitions.ts for growth management
 */

import type { EntityDefinition } from '../../types/entity-schema';

export const TIER_ENABLERS_ENTITIES: Record<string, EntityDefinition> = {
    dataset: {
        type: 'dataset',
        schema: 'entity.v1',
        idPrefix: 'hf-dataset--',
        seoType: 'Dataset',
        tier: 'enablers',
        capabilities: ['citations', 'size'],
        modules: ['CitationsModule', 'SizeModule'],
        requiredFields: ['name', 'author', 'task_categories'],
        display: {
            icon: '📊',
            color: 'green',
            labelSingular: 'Dataset',
            labelPlural: 'Datasets',
        },
    },

    benchmark: {
        type: 'benchmark',
        schema: 'entity.v1',
        idPrefix: 'benchmark--',
        seoType: 'Dataset',
        tier: 'enablers',
        capabilities: ['benchmark', 'citations'],
        modules: ['BenchmarkModule', 'CitationsModule'],
        requiredFields: ['name', 'metrics', 'task'],
        display: {
            icon: '🏆',
            color: 'orange',
            labelSingular: 'Benchmark',
            labelPlural: 'Benchmarks',
        },
    },
};
