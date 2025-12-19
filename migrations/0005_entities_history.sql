-- V6.2 Migration: Create entities_history table for FNI Velocity tracking
-- Run via: wrangler d1 execute ai-nexus-db --remote --file=migrations/0005_entities_history.sql

-- Drop if exists to allow re-run
DROP TABLE IF EXISTS entities_history;

CREATE TABLE entities_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id INTEGER NOT NULL,
    umid TEXT,
    type TEXT DEFAULT 'model',
    downloads INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    fni_score REAL,
    snapshot_date TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Create unique index for upsert conflict resolution
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_history_unique 
ON entities_history(entity_id, snapshot_date);

-- Index for efficient queries
CREATE INDEX IF NOT EXISTS idx_entities_history_date ON entities_history(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_entities_history_entity ON entities_history(entity_id);
