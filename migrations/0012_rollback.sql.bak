-- Migration number: 0012 Rollback
-- Description: Rollback GitHub repository statistics fields
-- Date: 2025-12-04

-- Drop indexes
DROP INDEX IF EXISTS idx_models_source_url;

-- Remove GitHub-specific columns
ALTER TABLE models DROP COLUMN github_stars;
ALTER TABLE models DROP COLUMN github_forks;
ALTER TABLE models DROP COLUMN github_last_commit;
ALTER TABLE models DROP COLUMN github_contributors;

-- This will restore the schema to the state before migration 0012
