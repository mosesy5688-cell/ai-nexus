/**
 * Entity Definitions Registry V5.2
 * Refactored: Merged from tier files for maintainability
 * Art.X-Entity-Contract: Rendering MUST follow entity.definition
 */

import type { EntityType } from '../types/entity';
import type { EntityDefinition } from '../types/entity-schema';

// Import tier definitions
import { TIER_CORE_ENTITIES } from './entity-types/tier-core';
import { TIER_ENABLERS_ENTITIES } from './entity-types/tier-enablers';
import { TIER_KNOWLEDGE_ENTITIES } from './entity-types/tier-knowledge';
import { TIER_ECOSYSTEM_ENTITIES } from './entity-types/tier-ecosystem';

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

/** Derive entity type from model object */
export function deriveEntityType(model: any): { type: EntityType, definition: EntityDefinition } {
    const id = model.id || model.umid || '';
    const def = getEntityDefinitionById(id) || ENTITY_DEFINITIONS['model'];
    return { type: def.type as EntityType, definition: def };
}

// Re-export tier modules for direct access
export { TIER_CORE_ENTITIES } from './entity-types/tier-core';
export { TIER_ENABLERS_ENTITIES } from './entity-types/tier-enablers';
export { TIER_KNOWLEDGE_ENTITIES } from './entity-types/tier-knowledge';
export { TIER_ECOSYSTEM_ENTITIES } from './entity-types/tier-ecosystem';
