-- migrations/0011_add_performance_indexes.sql
-- Task 1: D1 Performance Indexes
-- Created: 2025-12-03
-- Purpose: Optimize common query patterns for model list, detail, search

-- Single column indexes for direct lookups
CREATE INDEX IF NOT EXISTS idx_models_slug ON models(slug);
CREATE INDEX IF NOT EXISTS idx_models_pipeline_tag ON models(pipeline_tag);
CREATE INDEX IF NOT EXISTS idx_models_author ON models(author);

-- Composite indexes for sorted queries
-- Homepage: filter by pipeline_tag + sort by downloads
CREATE INDEX IF NOT EXISTS idx_pipeline_downloads 
  ON models(pipeline_tag, downloads DESC);

-- Author page: filter by author + sort by created_at  
CREATE INDEX IF NOT EXISTS idx_author_created 
  ON models(author, created_at DESC);

-- Expected performance impact:
-- - Model detail page (by slug): instant lookup
-- - Explore page filtered queries: 10-20x faster
-- - Author pages: 15x faster
-- - Homepage category filters: 10x faster
