-- V3.2 Migration: Add body_content_url for R2 content storage
-- This follows Constitution V3.1 Pillar III: Data Integrity

-- Add body_content_url column for R2 reference
ALTER TABLE models ADD COLUMN body_content_url TEXT;

-- Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_models_body_content_url ON models(body_content_url);
