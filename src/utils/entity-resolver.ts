/**
 * Entity Resolver
 * V4.9 Entity-First Architecture
 * 
 * Resolves entity ID/slug to entity type and definition
 * Art.X-Entity: Unknown types → return null (route to Shadow)
 */

import { deriveEntityType, type EntityType } from '../types/entity';
import { ENTITY_DEFINITIONS, getEntityDefinitionById } from '../data/entity-definitions';
import type { EntityDefinition, Entity } from '../types/entity-schema';

/**
 * Resolve entity from ID
 * Returns entity with definition or null if unknown type
 */
export function resolveEntityFromId(
    id: string,
    data: Record<string, any>
): Entity | null {
    const type = deriveEntityType(id);

    if (!type) {
        console.warn(`[EntityResolver] Unknown entity type for ID: ${id}`);
        return null; // Art.X-Entity: Unknown → Shadow DB
    }

    const definition = ENTITY_DEFINITIONS[type];

    if (!definition) {
        console.warn(`[EntityResolver] No definition for type: ${type}`);
        return null;
    }

    return {
        id,
        type,
        definition,
        data
    };
}

/**
 * Resolve entity type from slug pattern
 * For routes like /models/[slug], /datasets/[slug]
 */
export function resolveEntityTypeFromRoute(
    route: string
): EntityType | null {
    const routeMap: Record<string, EntityType> = {
        '/models': 'model',
        '/datasets': 'dataset',
        '/papers': 'paper',
        '/benchmarks': 'benchmark',
        '/agents': 'agent',
        '/tutorials': 'tutorial',
        '/organizations': 'organization',
    };

    for (const [prefix, type] of Object.entries(routeMap)) {
        if (route.startsWith(prefix)) {
            return type;
        }
    }

    return null;
}

/**
 * Get entity definition from type
 */
export function getDefinition(type: EntityType): EntityDefinition {
    return ENTITY_DEFINITIONS[type];
}

/**
 * Check if entity has specific capability
 */
export function hasCapability(
    definition: EntityDefinition,
    capability: string
): boolean {
    return definition.capabilities.includes(capability as any);
}

/**
 * Get capabilities for entity type
 */
export function getCapabilities(type: EntityType): string[] {
    return ENTITY_DEFINITIONS[type]?.capabilities || [];
}

/**
 * Get SEO schema type for entity
 */
export function getSEOSchemaType(type: EntityType): string {
    return ENTITY_DEFINITIONS[type]?.seoType || 'Thing';
}

/**
 * Format entity ID for display
 * Removes prefix and formats slug
 */
export function formatEntityId(id: string): string {
    // Remove any known prefix
    const prefixes = ['hf-model--', 'hf-dataset--', 'benchmark--', 'arxiv--', 'agent--'];

    let formatted = id;
    for (const prefix of prefixes) {
        if (id.startsWith(prefix)) {
            formatted = id.slice(prefix.length);
            break;
        }
    }

    // Replace -- with /
    return formatted.replace(/--/g, '/');
}
