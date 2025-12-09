-- Migration number: 0027
-- Description: Add Runtime Ecosystem fields for FNI Utility dimension
-- Date: 2025-12-09
-- Constitution: V3.3 Data Expansion - "Runtime First" Strategy

-- Ollama support detection
ALTER TABLE models ADD COLUMN has_ollama INTEGER DEFAULT 0;
ALTER TABLE models ADD COLUMN ollama_id TEXT;
ALTER TABLE models ADD COLUMN ollama_pulls INTEGER DEFAULT 0;

-- GGUF quantization support
ALTER TABLE models ADD COLUMN has_gguf INTEGER DEFAULT 0;
ALTER TABLE models ADD COLUMN gguf_variants TEXT;  -- JSON array of quantization types

-- Restore Utility dimension in FNI
ALTER TABLE models ADD COLUMN fni_u REAL DEFAULT 0;  -- Utility score

-- Index for runtime queries
CREATE INDEX IF NOT EXISTS idx_models_has_ollama ON models(has_ollama);
CREATE INDEX IF NOT EXISTS idx_models_has_gguf ON models(has_gguf);

-- Note: This migration supports the FNI Data Expansion
-- Utility score formula: has_ollama(+30) + has_gguf(+20) + complete_readme(+10) + docker(+10)
