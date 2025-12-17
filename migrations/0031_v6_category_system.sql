-- V6.0 Migration: Add category and size fields
-- Constitution Annex A.2 - Category System

-- Add primary_category field
ALTER TABLE models ADD COLUMN primary_category TEXT;

-- Add category confidence for ranking penalty
ALTER TABLE models ADD COLUMN category_confidence TEXT;

-- Add size bucket field
ALTER TABLE models ADD COLUMN size_bucket TEXT;

-- Add size source for tracking estimation method
ALTER TABLE models ADD COLUMN size_source TEXT;

-- Create index on primary_category for fast category queries
CREATE INDEX IF NOT EXISTS idx_models_primary_category ON models(primary_category);

-- Create index on size_bucket for filter queries
CREATE INDEX IF NOT EXISTS idx_models_size_bucket ON models(size_bucket);
