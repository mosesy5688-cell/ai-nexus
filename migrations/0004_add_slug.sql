-- Migration: Add slug column to models table
ALTER TABLE models ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX idx_slug ON models(slug);
