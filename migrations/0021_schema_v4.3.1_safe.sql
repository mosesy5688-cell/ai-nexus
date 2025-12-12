-- ============================================================
-- Free2AITools V4.3.1 Schema Migration (SAFE VERSION)
-- Date: 2025-12-11
-- Purpose: Add only MISSING columns and tables
-- Note: Some columns already exist (arxiv_id, has_ollama, has_gguf)
-- ============================================================

-- ============================================================
-- PART 1: Add ONLY missing columns to models table
-- ============================================================

-- UMID columns (NEW)
ALTER TABLE models ADD COLUMN umid TEXT;
ALTER TABLE models ADD COLUMN umid_version TEXT DEFAULT 'v1';
ALTER TABLE models ADD COLUMN canonical_name TEXT;
ALTER TABLE models ADD COLUMN author_fingerprint TEXT;

-- Note: arxiv_id, github_repo, doi, has_ollama, has_gguf already exist

-- Create indexes on new columns
CREATE INDEX IF NOT EXISTS idx_models_umid ON models(umid);
CREATE INDEX IF NOT EXISTS idx_models_canonical ON models(canonical_name);

-- ============================================================
-- PART 2: Entity Links table (NEW)
-- ============================================================

CREATE TABLE IF NOT EXISTS entity_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    source_umid TEXT,
    target_umid TEXT,
    link_type TEXT NOT NULL,
    confidence REAL DEFAULT 1.0 CHECK(confidence >= 0.35),
    match_method TEXT,
    match_score_matrix TEXT,
    source_trail TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_id, target_id, link_type)
);

CREATE INDEX IF NOT EXISTS idx_entity_links_source ON entity_links(source_id);
CREATE INDEX IF NOT EXISTS idx_entity_links_target ON entity_links(target_id);
CREATE INDEX IF NOT EXISTS idx_entity_links_umid ON entity_links(source_umid, target_umid);

-- ============================================================
-- PART 3: Models History table (NEW)
-- ============================================================

CREATE TABLE IF NOT EXISTS models_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id TEXT NOT NULL,
    umid TEXT,
    downloads INTEGER,
    likes INTEGER,
    fni_score REAL,
    fni_p REAL,
    fni_v REAL,
    fni_c REAL,
    fni_u REAL,
    snapshot_date TEXT NOT NULL,
    UNIQUE(model_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_models_history_model ON models_history(model_id);
CREATE INDEX IF NOT EXISTS idx_models_history_date ON models_history(snapshot_date);

-- ============================================================
-- PART 4: Shadow Database tables (NEW)
-- ============================================================

CREATE TABLE IF NOT EXISTS models_shadow (
    id TEXT PRIMARY KEY,
    raw_data TEXT,
    validation_errors TEXT,
    honeypot_triggers TEXT,
    source_file TEXT,
    reviewed INTEGER DEFAULT 0,
    reviewed_by TEXT,
    reviewed_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS quarantine_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    severity TEXT,
    source_file TEXT,
    reviewed INTEGER DEFAULT 0,
    reviewed_by TEXT,
    reviewed_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_quarantine_created ON quarantine_log(created_at);

-- ============================================================
-- PART 5: Affiliate Tracking table (NEW)
-- ============================================================

CREATE TABLE IF NOT EXISTS affiliate_clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id TEXT NOT NULL,
    umid TEXT,
    source TEXT NOT NULL,
    referer TEXT,
    user_agent TEXT,
    country TEXT,
    clicked_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_affiliate_model ON affiliate_clicks(model_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_date ON affiliate_clicks(clicked_at);

-- ============================================================
-- PART 6: Precompute Log table (NEW)
-- ============================================================

CREATE TABLE IF NOT EXISTS precompute_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cache_key TEXT NOT NULL UNIQUE,
    version TEXT NOT NULL,
    record_count INTEGER,
    generated_at TEXT NOT NULL,
    ttl INTEGER DEFAULT 3600
);
