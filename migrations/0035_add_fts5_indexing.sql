-- Migration: 0035_add_fts5_indexing.sql
-- Purpose: Add FTS5 search index for the Lean entities table (V6.2+)
-- Constitution Art 4.1: Metadata Only (No descriptions/content)
-- Strategy: Standalone Mode (High performance for Serverless/D1)

-- 1. DROP old index table if exists (Cleanup)
DROP TABLE IF EXISTS search_index;
DROP TABLE IF EXISTS entities_fts;

-- 2. CREATE optimized FTS5 table
CREATE VIRTUAL TABLE entities_fts USING fts5(
    id UNINDEXED,       -- Unique ID (hf--meta-llama/Llama-3)
    name,               -- Display Name
    author,             -- Provider
    tags,               -- JSON array of tags
    pipeline_tag,       -- HF Pipeline Tag
    primary_category,   -- V6.0 Taxonomy
    tokenize='porter unicode61'
);

-- 3. INITIAL POPULATION
INSERT INTO entities_fts (id, name, author, tags, pipeline_tag, primary_category)
SELECT id, name, author, tags, pipeline_tag, primary_category 
FROM entities;

-- 4. SYNC TRIGGERS
-- Insert trigger
CREATE TRIGGER IF NOT EXISTS entities_fts_insert AFTER INSERT ON entities BEGIN
    INSERT INTO entities_fts (id, name, author, tags, pipeline_tag, primary_category)
    VALUES (new.id, new.name, new.author, new.tags, new.pipeline_tag, new.primary_category);
END;

-- Delete trigger
CREATE TRIGGER IF NOT EXISTS entities_fts_delete AFTER DELETE ON entities BEGIN
    DELETE FROM entities_fts WHERE id = old.id;
END;

-- Update trigger
CREATE TRIGGER IF NOT EXISTS entities_fts_update AFTER UPDATE ON entities BEGIN
    DELETE FROM entities_fts WHERE id = old.id;
    INSERT INTO entities_fts (id, name, author, tags, pipeline_tag, primary_category)
    VALUES (new.id, new.name, new.author, new.tags, new.pipeline_tag, new.primary_category);
END;
