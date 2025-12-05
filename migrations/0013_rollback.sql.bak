-- Rollback Migration 0013: Remove ArXiv fields
-- Date: 2025-12-04
-- Purpose: Rollback ArXiv metadata changes

-- Drop indexes
DROP INDEX IF EXISTS idx_models_arxiv_category;
DROP INDEX IF EXISTS idx_models_arxiv_id;

-- Remove ArXiv columns
ALTER TABLE models DROP COLUMN arxiv_updated;
ALTER TABLE models DROP COLUMN arxiv_published;
ALTER TABLE models DROP COLUMN arxiv_category;
ALTER TABLE models DROP COLUMN arxiv_id;

-- Verify rollback
SELECT 
  name,
  type
FROM sqlite_master
WHERE tbl_name = 'models'
  AND name LIKE '%arxiv%'
ORDER BY type, name;

-- Should return no results if rollback successful
