-- Sprint 4 Phase 4: Entity Relations Table
-- Constitution V4.1: Neural Network Explorer Infrastructure
-- 
-- NOTE: This is storage-only. Real-time API is DEFERRED to Sprint 5
-- to protect D1 performance. GraphExplorer will use R2 precomputed JSONs.
--
-- Relation types:
--   'based_on'     - Model is based on another model
--   'cites'        - Model cites a paper
--   'trained_on'   - Model trained on a dataset
--   'documented_in' - Model documented in a tutorial

CREATE TABLE IF NOT EXISTS entity_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  type TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_id, target_id, type)
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_relations_source ON entity_relations(source_id);
CREATE INDEX IF NOT EXISTS idx_relations_target ON entity_relations(target_id);
CREATE INDEX IF NOT EXISTS idx_relations_type ON entity_relations(type);
