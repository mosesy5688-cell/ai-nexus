-- Migration number: 0026
-- Description: Add FNI (Free2AI Nexus Index) fields
-- Date: 2025-12-09
-- Constitution: V3.3 Pillar VII - Fair Index Standard

-- FNI Score fields
ALTER TABLE models ADD COLUMN fni_score REAL DEFAULT 0;
ALTER TABLE models ADD COLUMN fni_p REAL DEFAULT 0;  -- Popularity
ALTER TABLE models ADD COLUMN fni_v REAL DEFAULT 0;  -- Velocity
ALTER TABLE models ADD COLUMN fni_c REAL DEFAULT 0;  -- Credibility
ALTER TABLE models ADD COLUMN fni_percentile INTEGER DEFAULT 0;
ALTER TABLE models ADD COLUMN fni_commentary TEXT;  -- Auto-generated explanation
ALTER TABLE models ADD COLUMN fni_anomaly_flags TEXT;  -- JSON array
ALTER TABLE models ADD COLUMN fni_calculated_at TEXT;

-- Index for FNI-based queries
CREATE INDEX IF NOT EXISTS idx_models_fni_score ON models(fni_score DESC);
CREATE INDEX IF NOT EXISTS idx_models_fni_percentile ON models(fni_percentile);

-- Note: This migration supports the FNI (Free2AI Nexus Index) system
-- FNI = P(30%) + V(30%) + C(40%)
-- P = Popularity (likes, downloads, github_stars)
-- V = Velocity (7-day growth rate)
-- C = Credibility (arxiv, readme, author reputation)
