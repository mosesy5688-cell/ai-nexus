-- Migration 0013: Add ArXiv academic metadata fields
-- Date: 2025-12-04
-- Purpose: Enrich models with ArXiv paper metadata

-- Add ArXiv metadata columns
ALTER TABLE models ADD COLUMN arxiv_id TEXT;
ALTER TABLE models ADD COLUMN arxiv_category TEXT;
ALTER TABLE models ADD COLUMN arxiv_published TEXT;
ALTER TABLE models ADD COLUMN arxiv_updated TEXT;

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_models_arxiv_id ON models(arxiv_id);
CREATE INDEX IF NOT EXISTS idx_models_arxiv_category ON models(arxiv_category);

-- Verify schema changes
SELECT 
  name,
  type
FROM sqlite_master
WHERE tbl_name = 'models'
  AND (name LIKE '%arxiv%' OR type = 'table')
ORDER BY type, name;
