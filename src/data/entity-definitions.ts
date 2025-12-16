/**
 * Entity Definitions Registry
 * V4.9 Entity-First Architecture
 * 
 * This is the single source of truth for all entity configurations.
 * Art.X-Entity-Contract: Rendering MUST follow entity.definition
 */

import type { EntityType } from '../types/entity';
import type { EntityDefinition } from '../types/entity-schema';

/**
 * Complete Entity Definitions Registry
 * Each entity type has its full configuration defined here
 */
export const ENTITY_DEFINITIONS: Record<EntityType, EntityDefinition> = {
    // ═══════════════════════════════════════════════════════════
    // TIER 1: CORE
    // ═══════════════════════════════════════════════════════════

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

    // ═══════════════════════════════════════════════════════════
    // TIER 2: ENABLERS
    // ═══════════════════════════════════════════════════════════

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

    // ═══════════════════════════════════════════════════════════
    // TIER 3: KNOWLEDGE
    // ═══════════════════════════════════════════════════════════

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

    // ═══════════════════════════════════════════════════════════
    // TIER 4: ECOSYSTEM
    // ═══════════════════════════════════════════════════════════

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

/**
 * Get entity definition by type
 */
export function getEntityDefinition(type: EntityType): EntityDefinition {
    return ENTITY_DEFINITIONS[type];
}

/**
 * Get entity definition by ID
 */
export function getEntityDefinitionById(id: string): EntityDefinition | null {
    for (const [prefix, type] of Object.entries(ENTITY_DEFINITIONS)) {
        if (id.startsWith(ENTITY_DEFINITIONS[prefix as EntityType]?.idPrefix || '')) {
            return ENTITY_DEFINITIONS[prefix as EntityType];
        }
    }

    // Fallback: check prefixes directly
    const prefixMap: Record<string, EntityType> = {
        'hf-model--': 'model',
        'hf-dataset--': 'dataset',
        'benchmark--': 'benchmark',
        'arxiv--': 'paper',
        'agent--': 'agent',
        'tutorial--': 'tutorial',
        'org--': 'organization',
        'collection--': 'collection',
        'compare--': 'comparison',
        'deploy--': 'deployment',
    };

    for (const [prefix, type] of Object.entries(prefixMap)) {
        if (id.startsWith(prefix)) {
            return ENTITY_DEFINITIONS[type];
        }
    }

    return null;
}

/**
 * Check if entity type has a specific capability
 */
export function entityHasCapability(
    type: EntityType,
    capability: string
): boolean {
    const definition = ENTITY_DEFINITIONS[type];
    return definition?.capabilities.includes(capability as any) ?? false;
}

/**
 * Derive entity type from model object (Helper)
 */
export function deriveEntityType(model: any): { type: EntityType, definition: EntityDefinition } {
    const id = model.id || model.umid || '';
    const def = getEntityDefinitionById(id) || ENTITY_DEFINITIONS['model'];
    return { type: def.type, definition: def };
}
