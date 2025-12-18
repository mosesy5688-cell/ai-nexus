-- Migration: V6.1+ Sitemap Optimization - Add archiving support
-- Date: 2025-12-18
-- Purpose: Enable soft-delete for URL stability (Constitution Art 6.3)

-- Add archived flag for soft-delete
ALTER TABLE models ADD COLUMN archived INTEGER DEFAULT 0;

-- Add timestamp for when archived
ALTER TABLE models ADD COLUMN archived_at TEXT;

-- Index for sitemap performance (exclude archived, sort by FNI)
CREATE INDEX IF NOT EXISTS idx_models_sitemap ON models(archived, fni_score DESC);

