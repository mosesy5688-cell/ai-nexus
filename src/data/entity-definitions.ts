/**
 * Entity Definitions Registry V5.2
 * Refactored: Merged from tier files for maintainability
 * Art.X-Entity-Contract: Rendering MUST follow entity.definition
 */

import type { EntityType } from '../types/entity';
import type { EntityDefinition } from '../types/entity-schema';

// Import tier definitions
import { TIER_CORE_ENTITIES } from './entity-types/tier-core.js';
import { TIER_ENABLERS_ENTITIES } from './entity-types/tier-enablers.js';
import { TIER_KNOWLEDGE_ENTITIES } from './entity-types/tier-knowledge.js';
import { TIER_ECOSYSTEM_ENTITIES } from './entity-types/tier-ecosystem.js';

// Merge all entity definitions
export const ENTITY_DEFINITIONS: Record<EntityType, EntityDefinition> = {
    ...TIER_CORE_ENTITIES,
    ...TIER_ENABLERS_ENTITIES,
    ...TIER_KNOWLEDGE_ENTITIES,
    ...TIER_ECOSYSTEM_ENTITIES,
} as Record<EntityType, EntityDefinition>;

// ID prefix to type mapping (for fast lookup)
const PREFIX_MAP: Record<string, EntityType> = {
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
    'tool--': 'tool',
    'hf-agent--': 'agent',
};

/** Get entity definition by type */
export function getEntityDefinition(type: EntityType): EntityDefinition {
    return ENTITY_DEFINITIONS[type];
}

/** Get entity definition by ID (via prefix matching) */
export function getEntityDefinitionById(id: string): EntityDefinition | null {
    for (const [prefix, type] of Object.entries(PREFIX_MAP)) {
        if (id.startsWith(prefix)) {
            return ENTITY_DEFINITIONS[type];
        }
    }
    return null;
}

/** Check if entity type has a specific capability */
export function entityHasCapability(type: EntityType, capability: string): boolean {
    const definition = ENTITY_DEFINITIONS[type];
    return definition?.capabilities.includes(capability as any) ?? false;
}

/** Derive entity type from model object (with optional hint) */
export function deriveEntityType(model: any, typeHint?: EntityType): { type: EntityType, definition: EntityDefinition } {
    const id = (model.id || model.umid || '').toLowerCase();

    // 0. Trust the hint if provided (V16.11)
    if (typeHint && ENTITY_DEFINITIONS[typeHint]) {
        return { type: typeHint, definition: ENTITY_DEFINITIONS[typeHint] };
    }

    // 1. Try prefix matching
    const prefixDef = getEntityDefinitionById(id);
    if (prefixDef) return { type: prefixDef.type as EntityType, definition: prefixDef };

    // 2. Try semantic keyword matching (V16.11)
    if (id.includes('agent--') || id.includes('/agents/') || id.includes('-agent-') || id.endsWith('-agent')) {
        return { type: 'agent', definition: ENTITY_DEFINITIONS['agent'] };
    }
    if (id.includes('dataset--') || id.includes('datasets/')) {
        return { type: 'dataset', definition: ENTITY_DEFINITIONS['dataset'] };
    }
    if (id.includes('space--') || id.includes('spaces/')) {
        return { type: 'space', definition: ENTITY_DEFINITIONS['space'] };
    }
    if (id.includes('tool--') || id.includes('/tools/') || id.includes('framework') || id.includes('library')) {
        return { type: 'tool', definition: ENTITY_DEFINITIONS['tool'] };
    }
    if (id.includes('arxiv--') || id.includes('paper--') || id.includes('arxiv:')) {
        return { type: 'paper', definition: ENTITY_DEFINITIONS['paper'] };
    }

    // 3. Last resort fallback
    return { type: 'model', definition: ENTITY_DEFINITIONS['model'] };
}

// Re-export tier modules for direct access
export { TIER_CORE_ENTITIES } from './entity-types/tier-core.js';
export { TIER_ENABLERS_ENTITIES } from './entity-types/tier-enablers.js';
export { TIER_KNOWLEDGE_ENTITIES } from './entity-types/tier-knowledge.js';
export { TIER_ECOSYSTEM_ENTITIES } from './entity-types/tier-ecosystem.js';
