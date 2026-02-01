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
    | 'prompt'       // Tier 3: Knowledge - Prompts (LangChain)
    | 'deployment';  // Hosted instances

/**
 * Entity ID prefix mapping for type derivation
 * Used by deriveEntityType() function
 */
export const ENTITY_ID_PREFIXES: Record<string, EntityType> = {
    // Tier 1: Core
    'hf-model--': 'model',
    'gh-model--': 'model',
    'kaggle-model--': 'model',
    'civitai-model--': 'model',
    'ollama-model--': 'model',
    'replicate-model--': 'model',

    // Tier 2: Enablers
    'hf-dataset--': 'dataset',
    'kaggle-dataset--': 'dataset',
    'hf-space--': 'space',
    'benchmark--': 'benchmark',

    // Tier 3: Knowledge
    'arxiv-paper--': 'paper',
    'hf-paper--': 'paper',
    'tutorial--': 'tutorial',
    'knowledge--': 'knowledge' as any, // fallback for legacy

    // Tier 4: Ecosystem
    'gh-agent--': 'agent',
    'hf-agent--': 'agent',
    'langchain-agent--': 'agent',
    'mcp-server--': 'agent' as any, // server as agent
    'gh-tool--': 'tool',
    'gh-repo--': 'tool',

    // Others
    'collection--': 'collection',
    'compare--': 'comparison',
    'deploy--': 'deployment',
    'report--': 'paper' as any, // reports are specialized knowledge
    'langchain-prompt--': 'prompt',
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
