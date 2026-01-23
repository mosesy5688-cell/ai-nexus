/**
 * Entity Type Definitions
 * V4.9 Entity-First Architecture
 * 
 * Art.X-Entity: Frontend MUST render by entity.definition
 */

/**
 * Core entity types supported by the platform
 * Model remains the gravitational center (Tier 1)
 */
export type EntityType =
    | 'model'        // Tier 1: Core - AI models (LLM, vision, etc.)
    | 'dataset'      // Tier 2: Enablers - Training/evaluation datasets
    | 'space'        // Tier 2: Enablers - Interactive demos (HuggingFace Spaces)
    | 'benchmark'    // Tier 2: Enablers - Evaluation benchmarks
    | 'paper'        // Tier 3: Knowledge - Research papers
    | 'agent'        // Tier 4: Ecosystem - AI agents, tools
    | 'tutorial'     // Tier 3: Knowledge - How-to guides
    | 'organization' // Tier 4: Ecosystem - Companies, labs
    | 'collection'   // Curated lists
    | 'comparison'   // Model comparisons
    | 'tool'         // Tier 4: Ecosystem - Specialized AI tools
    | 'deployment';  // Hosted instances

/**
 * Entity ID prefix mapping for type derivation
 * Used by deriveEntityType() function
 */
export const ENTITY_ID_PREFIXES: Record<string, EntityType> = {
    'hf-model--': 'model',
    'hf-dataset--': 'dataset',
    'hf-space--': 'space',
    'benchmark--': 'benchmark',
    'arxiv--': 'paper',
    'agent--': 'agent',
    'github-agent--': 'agent',  // V12: GitHub agent frameworks
    'tutorial--': 'tutorial',
    'org--': 'organization',
    'collection--': 'collection',
    'compare--': 'comparison',
    'deploy--': 'deployment',
    'hf-agent--': 'agent',
    'tool--': 'tool',
};

/**
 * Derive entity type from entity ID
 * 
 * @param id - Entity ID (e.g., 'hf-model--meta-llama--llama-3')
 * @returns EntityType or null if unknown
 * 
 * Art.X-Entity: Unknown types → Shadow DB
 */
export function deriveEntityType(id: string): EntityType | null {
    for (const [prefix, type] of Object.entries(ENTITY_ID_PREFIXES)) {
        if (id.startsWith(prefix)) {
            return type;
        }
    }
    return null;
}

/**
 * Entity tier for hierarchy
 */
export type EntityTier =
    | 'core'       // Tier 1: Model
    | 'enablers'   // Tier 2: Dataset, Benchmark
    | 'knowledge'  // Tier 3: Paper, Tutorial
    | 'ecosystem'; // Tier 4: Agent, Hardware, etc.

/**
 * Get tier for entity type
 */
export function getEntityTier(type: EntityType): EntityTier {
    switch (type) {
        case 'model':
            return 'core';
        case 'dataset':
        case 'benchmark':
            return 'enablers';
        case 'paper':
        case 'tutorial':
            return 'knowledge';
        default:
            return 'ecosystem';
    }
}
