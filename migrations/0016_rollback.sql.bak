-- Rollback Migration 0016: Remove FTS5 Full-Text Search
-- Date: 2025-12-05
-- Purpose: Rollback FTS5 implementation

-- Drop triggers (must be done before dropping table)
DROP TRIGGER IF EXISTS models_fts_delete;
DROP TRIGGER IF EXISTS models_fts_update;
DROP TRIGGER IF EXISTS models_fts_insert;

-- Drop FTS5 virtual table
DROP TABLE IF EXISTS models_fts;

-- Verify rollback complete
SELECT name, type 
FROM sqlite_master 
WHERE name LIKE 'models_fts%';

-- Should return no results if rollback successful
