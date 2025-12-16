/**
 * Entity Types - Tier 4: Ecosystem
 * V5.2 - Split from entity-definitions.ts for growth management
 */

import type { EntityDefinition } from '../../types/entity-schema';

export const TIER_ECOSYSTEM_ENTITIES: Record<string, EntityDefinition> = {
    agent: {
        type: 'agent',
        schema: 'entity.v1',
        idPrefix: 'agent--',
        seoType: 'SoftwareApplication',
        tier: 'ecosystem',
        capabilities: ['deploy', 'architecture', 'integrations', 'pricing'],
        modules: ['DeployModule', 'ArchitectureModule', 'IntegrationsModule', 'PricingModule'],
        requiredFields: ['name', 'capabilities', 'uses_model'],
        display: {
            icon: '🤖',
            color: 'pink',
            labelSingular: 'Agent',
            labelPlural: 'Agents',
        },
    },

    organization: {
        type: 'organization',
        schema: 'entity.v1',
        idPrefix: 'org--',
        seoType: 'Organization',
        tier: 'ecosystem',
        capabilities: [],
        modules: [],
        requiredFields: ['name', 'type'],
        display: {
            icon: '🏢',
            color: 'gray',
            labelSingular: 'Organization',
            labelPlural: 'Organizations',
        },
    },

    collection: {
        type: 'collection',
        schema: 'entity.v1',
        idPrefix: 'collection--',
        seoType: 'ItemList',
        tier: 'ecosystem',
        capabilities: [],
        modules: [],
        requiredFields: ['title', 'items', 'curator'],
        display: {
            icon: '📁',
            color: 'teal',
            labelSingular: 'Collection',
            labelPlural: 'Collections',
        },
    },

    comparison: {
        type: 'comparison',
        schema: 'entity.v1',
        idPrefix: 'compare--',
        seoType: 'ItemList',
        tier: 'ecosystem',
        capabilities: ['benchmark', 'architecture', 'pricing'],
        modules: ['BenchmarkModule', 'ArchitectureModule', 'PricingModule'],
        requiredFields: ['models', 'criteria'],
        display: {
            icon: '⚖️',
            color: 'indigo',
            labelSingular: 'Comparison',
            labelPlural: 'Comparisons',
        },
    },

    deployment: {
        type: 'deployment',
        schema: 'entity.v1',
        idPrefix: 'deploy--',
        seoType: 'WebAPI',
        tier: 'ecosystem',
        capabilities: ['deploy', 'pricing', 'integrations'],
        modules: ['DeployModule', 'PricingModule', 'IntegrationsModule'],
        requiredFields: ['model', 'provider', 'endpoint'],
        display: {
            icon: '🚀',
            color: 'red',
            labelSingular: 'Deployment',
            labelPlural: 'Deployments',
        },
    },
};
