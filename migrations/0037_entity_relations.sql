-- V12: Entity Relations Table
-- Stores explicit relationships between entities for knowledge graph
-- Supports: BASED_ON, TRAINED_ON, CITES, USES relations

CREATE TABLE IF NOT EXISTS entity_relations (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,
  source TEXT DEFAULT 'tag',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_id, target_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_relations_source ON entity_relations(source_id);
CREATE INDEX IF NOT EXISTS idx_relations_target ON entity_relations(target_id);
CREATE INDEX IF NOT EXISTS idx_relations_type ON entity_relations(relation_type);
