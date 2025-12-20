-- Migration: Phase A.1 - D1 Ultra-Lean Schema (V6.2)
-- Purpose: Reduce D1 storage from ~5KB/row to ~500B/row
-- Strategy: D1 = Index Only, R2 = Content Storage

-- ============================================================
-- STEP 1: Create lean entities table (Index-Only)
-- ============================================================

CREATE TABLE IF NOT EXISTS entities_lean (
    -- Primary Key
    id TEXT PRIMARY KEY,                    -- e.g., "hf--meta-llama/Llama-3-70b"
    
    -- Core Identity (Required)
    type TEXT NOT NULL DEFAULT 'model',     -- model, dataset, paper, agent, space
    name TEXT NOT NULL,                     -- Display name
    author TEXT NOT NULL,                   -- Creator/Organization
    
    -- Metrics (Hot Data for Sorting)
    likes INTEGER DEFAULT 0,
    downloads INTEGER DEFAULT 0,
    fni_score REAL DEFAULT 0,               -- Freshness & Newness Index (L5 computed)
    
    -- Timestamps
    last_modified TEXT,                     -- Source last modified
    indexed_at TEXT DEFAULT CURRENT_TIMESTAMP,
    
    -- Search & Filter
    pipeline_tag TEXT,                      -- text-generation, image-classification, etc.
    primary_category TEXT,                  -- V6.0 category system
    tags TEXT,                              -- JSON array of tags (for filtering)
    
    -- Source Tracking
    source TEXT,                            -- huggingface, github, arxiv, etc.
    source_url TEXT,                        -- Original URL
    
    -- Status
    link_status TEXT DEFAULT 'ok'           -- ok, broken, archived
    
    -- REMOVED TO R2:
    -- description (-> R2: entities/{id}/meta.json)
    -- body_content (-> R2: docs/{id}.md)
    -- metadata (-> R2: entities/{id}/meta.json)
    -- config (-> R2: entities/{id}/config.json)
);

-- ============================================================
-- STEP 2: Create Performance Indexes
-- ============================================================

-- Primary sort indexes
CREATE INDEX IF NOT EXISTS idx_lean_type_fni ON entities_lean(type, fni_score DESC);
CREATE INDEX IF NOT EXISTS idx_lean_type_likes ON entities_lean(type, likes DESC);
CREATE INDEX IF NOT EXISTS idx_lean_type_downloads ON entities_lean(type, downloads DESC);
CREATE INDEX IF NOT EXISTS idx_lean_modified ON entities_lean(last_modified DESC);

-- Search indexes
CREATE INDEX IF NOT EXISTS idx_lean_author ON entities_lean(author);
CREATE INDEX IF NOT EXISTS idx_lean_category ON entities_lean(primary_category);
CREATE INDEX IF NOT EXISTS idx_lean_pipeline ON entities_lean(pipeline_tag);
CREATE INDEX IF NOT EXISTS idx_lean_source ON entities_lean(source);

-- ============================================================
-- STEP 3: Migrate Data from existing entities table
-- ============================================================

INSERT OR IGNORE INTO entities_lean (
    id, type, name, author,
    likes, downloads, fni_score,
    last_modified, indexed_at,
    pipeline_tag, primary_category, tags,
    source, source_url, link_status
)
SELECT 
    id,
    COALESCE(type, 'model'),
    COALESCE(name, id),
    COALESCE(author, 'unknown'),
    COALESCE(likes, 0),
    COALESCE(downloads, 0),
    COALESCE(fni_score, 0),
    last_modified,
    COALESCE(indexed_at, CURRENT_TIMESTAMP),
    pipeline_tag,
    primary_category,
    tags,
    source,
    source_url,
    COALESCE(link_status, 'ok')
FROM entities;

-- ============================================================
-- STEP 4: Swap Tables (Manual Execution Recommended)
-- ============================================================
-- CAUTION: Run these manually after verifying data migration

-- DROP TABLE entities;
-- ALTER TABLE entities_lean RENAME TO entities;

-- ============================================================
-- NOTES:
-- - After swap, update L8 Worker to NOT insert content fields
-- - L1 Harvester should upload content to R2 instead
-- - Frontend fetches content from R2 on-demand
-- ============================================================
