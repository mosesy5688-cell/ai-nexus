
-- Migration: Universal Entity Protocol (V6.2)
-- Rename 'models' to 'entities' and add hybrid metadata column

-- 1. Rename Table
ALTER TABLE models RENAME TO entities;
ALTER TABLE models_shadow RENAME TO entities_shadow;
ALTER TABLE models_history RENAME TO entities_history;

-- 2. Add Type Discriminator
ALTER TABLE entities ADD COLUMN type TEXT DEFAULT 'model';

-- 3. Add Hybrid Metadata Column (JSON)
-- Stores: parameters, num_rows, sdk, etc.
ALTER TABLE entities ADD COLUMN metadata TEXT;

-- 4. Create Indexes for new columns
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
-- Metadata is JSON, usually not indexed directly unless using generated columns
-- We rely on App-Layer filtering for metadata fields for now or specific extra indexes if needed

-- 5. Update Indexes (Optional if SQLite handles rename automatically, but good to verify)
-- SQLite usually handles index renaming with table rename.
-- idx_models_slug -> idx_entities_slug (automatic?)
-- Start fresh references if needed.

