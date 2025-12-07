-- Migration: Add fields for AI-generated content (Loop 2)
ALTER TABLE models ADD COLUMN analysis_content TEXT;
ALTER TABLE models ADD COLUMN seo_tags TEXT;
ALTER TABLE models ADD COLUMN last_enriched_at INTEGER;
ALTER TABLE models ADD COLUMN seo_status TEXT DEFAULT 'pending'; -- pending, processing, done


-- Index for finding pending models quickly
CREATE INDEX IF NOT EXISTS idx_models_seo_status ON models(seo_status);
