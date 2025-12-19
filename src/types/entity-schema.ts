/**
 * Entity Schema and Definition
 * V4.9 Entity-First Architecture
 * 
 * Art.X-Entity-Contract: Rendering MUST follow entity.definition
 */

import type { EntityType, EntityTier } from './entity';
import type { EntityCapability } from './entity-capability';

/**
 * Schema.org type mapping for SEO (Art.IX SEO Ready)
 */
export type SEOSchemaType =
    | 'SoftwareApplication'  // model, agent
    | 'Dataset'              // dataset, benchmark
    | 'ScholarlyArticle'     // paper
    | 'HowTo'                // tutorial
    | 'Organization'         // organization
    | 'ItemList'             // collection, comparison
    | 'WebAPI';              // deployment

/**
 * Entity Definition Interface
 * The core contract for entity rendering
 */
export interface EntityDefinition {
    /** Entity type */
    type: EntityType;

    /** Schema version */
    schema: 'entity.v1';

    /** ID prefix for this entity type */
    idPrefix: string;

    /** Schema.org type for SEO */
    seoType: SEOSchemaType;

    /** Entity tier in hierarchy */
    tier: EntityTier;

    /** Capabilities this entity type supports */
    capabilities: EntityCapability[];

    /** UI modules allowed for this entity type */
    modules: string[];

    /** Required fields for this entity type */
    requiredFields: string[];

    /** Display configuration */
    display: {
        /** Icon emoji */
        icon: string;
        /** Color theme */
        color: string;
        /** Singular label */
        labelSingular: string;
        /** Plural label */
        labelPlural: string;
    };
}

/**
 * Entity instance with resolved definition
 */
export interface Entity {
    /** Unique entity ID */
    id: string;

    /** Entity type */
    type: EntityType;

    /** Entity definition */
    definition: EntityDefinition;

    /** Raw data from cache */
    data: Record<string, unknown>;
}

/**
 * Entity relation types for graph
 */
export type EntityRelationType =
    | 'trained_on'       // Model → Dataset
    | 'fine_tuned_on'    // Model → Dataset
    | 'introduced_by'    // Model/Dataset → Paper
    | 'evaluated_on'     // Model → Benchmark
    | 'powers'           // Model → Agent
    | 'runs_on'          // Model → Hardware
    | 'cites'            // Paper → Paper
    | 'used_by'          // Dataset → Model
    | 'published_by';    // Entity → Organization

/**
 * Entity relation for internal linking
 * Art.X-Entity-Link: All entities MUST have relation links
 */
export interface EntityRelation {
    /** Source entity ID */
    sourceId: string;

    /** Target entity ID */
    targetId: string;

    /** Relation type */
    type: EntityRelationType;

    /** Display label */
    label: string;
}


/**
 * ==========================================
 * V6.2 Universal Entity Protocol
 * ==========================================
 */

/**
 * Base Entity Interface (Common V6.1 Protocol)
 */
export interface BaseEntity {
    id: string;
    type: EntityType;
    name: string;
    author: string;
    last_modified: string;

    // V6.1 Full Fidelity Stats
    stats: {
        likes: number;
        downloads?: number; // Space might not have downloads
        fni_score?: number; // Internal Metric
    };

    // V6.1 Content Protocol
    author_docs: {
        readme_ref: string; // Pointer to entities/{type}/{id}/readme.md.gz
        readme_hash: string;
    };

    // Generic metadata bag (V6.1 Schema Optimization)
    // Stores type-specific fields that aren't indexed for search
    metadata?: Record<string, unknown>;
}

/**
 * 1. Model Entity (Tier 1)
 */
export interface ModelEntity extends BaseEntity {
    type: 'model';
    pipeline_tag?: string; // Core classification
    metadata?: {
        parameters?: string;
        precision?: string;
        context_length?: string;
    };
}

/**
 * 2. Dataset Entity (Tier 2)
 */
export interface DatasetEntity extends BaseEntity {
    type: 'dataset';
    metadata?: {
        size_categories?: string | string[]; // e.g. "100K-1M"
        num_rows?: number;
        format?: string[];
    };
}

/**
 * 3. Space Entity (Tier 2)
 */
export interface SpaceEntity extends BaseEntity {
    type: 'space';
    metadata?: {
        sdk?: 'gradio' | 'streamlit' | 'docker' | 'static';
        app_file?: string;
        running_status?: 'running' | 'sleeping' | 'building' | 'error';
    };
}

/**
 * The Universal Entity Union
 */
export type UniversalEntity = ModelEntity | DatasetEntity | SpaceEntity;

