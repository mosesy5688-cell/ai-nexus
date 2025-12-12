-- migrations/0024_umid_resolver.sql
-- UMID Resolution Layer V4.3.2 Constitution Compliant
-- Single Source of Truth for all external ID mappings
-- NOTE: D1 does not support explicit transactions in SQL files

-- Create umid_resolver table
CREATE TABLE IF NOT EXISTS umid_resolver (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  canonical_umid TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, source_id)
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_resolver_source_id ON umid_resolver(source, source_id);
CREATE INDEX IF NOT EXISTS idx_resolver_umid ON umid_resolver(canonical_umid);
CREATE INDEX IF NOT EXISTS idx_resolver_source ON umid_resolver(source);
