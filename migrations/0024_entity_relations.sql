-- Migration 0024: Entity Relations Table
-- Sprint 2: Knowledge Graph Foundation
-- Purpose: Store relationships between AI entities (models, papers, datasets, tools)

CREATE TABLE IF NOT EXISTS entity_relations (
    -- Composite primary key
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    
    -- Relation metadata
    confidence REAL DEFAULT 1.0,
    source_url TEXT,
    is_official INTEGER DEFAULT 0,
    
    -- Audit fields
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    
    PRIMARY KEY (source_id, target_id, relation_type)
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_relations_source ON entity_relations(source_id);
CREATE INDEX IF NOT EXISTS idx_relations_target ON entity_relations(target_id);
CREATE INDEX IF NOT EXISTS idx_relations_type ON entity_relations(relation_type);

-- Common relation types:
-- 'implements'      - Paper implements Model
-- 'trains_on'       - Model trains on Dataset
-- 'cites'           - Paper cites Paper
-- 'has_code'        - Paper has GitHub implementation
-- 'same_as'         - ArXiv paper same as PWC paper
-- 'based_on'        - Model based on another Model
