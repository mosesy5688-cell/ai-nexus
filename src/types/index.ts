/**
 * Entity Types Index
 * V4.9 Entity-First Architecture
 * 
 * Re-exports all entity-related types and utilities
 */

// Core types
export type { EntityType, EntityTier } from './entity';
export {
    ENTITY_ID_PREFIXES,
    deriveEntityType,
    getEntityTier
} from './entity';

// Capabilities
export type { EntityCapability } from './entity-capability';
export {
    CAPABILITY_MODULES,
    hasCapability,
    getEnabledModules
} from './entity-capability';

// Schema and definitions
export type {
    EntityDefinition,
    Entity,
    EntityRelation,
    EntityRelationType,
    SEOSchemaType
} from './entity-schema';
