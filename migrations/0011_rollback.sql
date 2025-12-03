-- migrations/0011_rollback.sql
-- Rollback for 0011_add_performance_indexes.sql
-- Purpose: Remove all indexes if needed

DROP INDEX IF EXISTS idx_models_slug;
DROP INDEX IF EXISTS idx_models_pipeline_tag;
DROP INDEX IF EXISTS idx_models_author;
DROP INDEX IF EXISTS idx_pipeline_downloads;
DROP INDEX IF EXISTS idx_author_created;

-- To rollback, run:
-- wrangler d1 execute ai-nexus-db --file=migrations/0011_rollback.sql
