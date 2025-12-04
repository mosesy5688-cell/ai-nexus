-- Migration number: 0012
-- Description: Add GitHub repository statistics fields
-- Date: 2025-12-04
-- Task: P1 Task 6 - GitHub Data Source Integration

-- Add GitHub-specific fields to models table
ALTER TABLE models ADD COLUMN github_stars INTEGER DEFAULT 0;
ALTER TABLE models ADD COLUMN github_forks INTEGER DEFAULT 0;
ALTER TABLE models ADD COLUMN github_last_commit TEXT;
ALTER TABLE models ADD COLUMN github_contributors INTEGER DEFAULT 0;

-- Create index for GitHub-enabled models (for enrichment queries)
CREATE INDEX IF NOT EXISTS idx_models_source_url ON models(source_url);

-- Note: This migration is safe and will not affect existing data
-- Rollback script available in 0012_rollback.sql
