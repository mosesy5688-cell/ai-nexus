-- Migration number: 0020
-- Description: V3.1 Schema - Knowledge Graph & Commercial Features
-- Date: 2025-12-07
-- Purpose: Add commercial slots, NotebookLM summaries, and source trail auditing
-- Note: This is an ADDITIVE migration - no data is deleted

-- ============================================================================
-- A. MODELS TABLE ENHANCEMENTS (Commercial + AI Summary)
-- ============================================================================

-- Commercial slots: JSON field for contextual affiliate recommendations
-- Format: [{"type": "gpu", "text": "Train on RunPod A100", "url": "..."}]
ALTER TABLE models ADD COLUMN commercial_slots TEXT DEFAULT '[]';

-- NotebookLM-style deep summary for high-value content generation
ALTER TABLE models ADD COLUMN notebooklm_summary TEXT;

-- Source trail: Track where this model's data originated
ALTER TABLE models ADD COLUMN source_trail TEXT DEFAULT '[]';
-- Format: [{"source": "huggingface", "fetched_at": "2025-12-07T00:00:00Z", "confidence": 0.95}]

-- Velocity score for trending calculation (Loop 5: Analyst)
ALTER TABLE models ADD COLUMN velocity_score REAL DEFAULT 0;

-- Last commercial injection timestamp (Loop 6: Merchant)
ALTER TABLE models ADD COLUMN last_commercial_at DATETIME;

-- ============================================================================
-- B. PAPERS TABLE (Academic Knowledge Graph Node)
-- ============================================================================

CREATE TABLE IF NOT EXISTS papers (
    id TEXT PRIMARY KEY,              -- e.g., "arxiv-2301.00234"
    title TEXT NOT NULL,
    authors TEXT,                     -- JSON array of author names
    abstract TEXT,
    arxiv_id TEXT,
    doi TEXT,
    pdf_url TEXT,
    published_date DATETIME,
    citations INTEGER DEFAULT 0,
    source_trail TEXT DEFAULT '[]',   -- Audit trail
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_papers_arxiv ON papers(arxiv_id);
CREATE INDEX IF NOT EXISTS idx_papers_published ON papers(published_date DESC);

-- ============================================================================
-- C. REPOS TABLE (GitHub/GitLab Knowledge Graph Node)
-- ============================================================================

CREATE TABLE IF NOT EXISTS repos (
    id TEXT PRIMARY KEY,              -- e.g., "github-langchain-ai-langchain"
    name TEXT NOT NULL,
    owner TEXT NOT NULL,
    platform TEXT DEFAULT 'github',   -- github, gitlab, etc.
    description TEXT,
    stars INTEGER DEFAULT 0,
    forks INTEGER DEFAULT 0,
    language TEXT,
    license TEXT,
    topics TEXT,                      -- JSON array
    homepage_url TEXT,
    repo_url TEXT,
    last_commit_at DATETIME,
    source_trail TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_repos_platform ON repos(platform);
CREATE INDEX IF NOT EXISTS idx_repos_stars ON repos(stars DESC);
CREATE INDEX IF NOT EXISTS idx_repos_owner ON repos(owner);

-- ============================================================================
-- D. DATASETS TABLE (Dataset Knowledge Graph Node)
-- ============================================================================

CREATE TABLE IF NOT EXISTS datasets (
    id TEXT PRIMARY KEY,              -- e.g., "huggingface-squad"
    name TEXT NOT NULL,
    author TEXT,
    description TEXT,
    size_bytes INTEGER,
    num_rows INTEGER,
    task_categories TEXT,             -- JSON array
    languages TEXT,                   -- JSON array
    license TEXT,
    downloads INTEGER DEFAULT 0,
    source_url TEXT,
    source_trail TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_datasets_downloads ON datasets(downloads DESC);

-- ============================================================================
-- E. MODEL_SOURCES TABLE (Source Trail Audit Log)
-- ============================================================================

CREATE TABLE IF NOT EXISTS model_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id TEXT NOT NULL,
    source_platform TEXT NOT NULL,    -- huggingface, github, arxiv, etc.
    source_url TEXT,
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    data_hash TEXT,                   -- SHA256 of fetched data for dedup
    confidence_score REAL DEFAULT 1.0,
    raw_data TEXT,                    -- Original JSON snapshot
    FOREIGN KEY (model_id) REFERENCES models(id)
);

CREATE INDEX IF NOT EXISTS idx_model_sources_model ON model_sources(model_id);
CREATE INDEX IF NOT EXISTS idx_model_sources_platform ON model_sources(source_platform);

-- ============================================================================
-- F. AFFILIATE_RULES TABLE (Commercial Engine Configuration)
-- ============================================================================

CREATE TABLE IF NOT EXISTS affiliate_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_name TEXT NOT NULL,
    match_type TEXT NOT NULL,         -- tag, pipeline, keyword, author
    match_value TEXT NOT NULL,        -- The value to match against
    slot_type TEXT NOT NULL,          -- gpu, cloud, api, course, book
    slot_content TEXT NOT NULL,       -- JSON with text, url, priority
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_affiliate_match ON affiliate_rules(match_type, match_value);

-- ============================================================================
-- G. UNIFIED SEARCH INDEX (FTS5 for All Entity Types)
-- ============================================================================

-- Note: This extends the existing models_fts with cross-entity search
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
    entity_type,    -- model, paper, repo, dataset
    entity_id,      -- Reference to source table
    title,          -- Searchable title/name
    description,    -- Searchable description
    author,         -- Author/owner
    tags,           -- Tags/topics
    content='',     -- External content table (manual sync)
    tokenize='porter unicode61'
);

-- ============================================================================
-- H. COMMERCIAL SLOTS LOG (Analytics for Loop 5)
-- ============================================================================

CREATE TABLE IF NOT EXISTS commercial_impressions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id TEXT NOT NULL,
    slot_type TEXT NOT NULL,
    impression_date DATE DEFAULT (date('now')),
    click_count INTEGER DEFAULT 0,
    impression_count INTEGER DEFAULT 1,
    UNIQUE(model_id, slot_type, impression_date)
);

CREATE INDEX IF NOT EXISTS idx_impressions_date ON commercial_impressions(impression_date);

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
-- Summary:
--   - Added 5 columns to models table
--   - Created 6 new tables: papers, repos, datasets, model_sources, 
--     affiliate_rules, commercial_impressions
--   - Created 1 FTS5 table: search_index
--   - Total: 14 new indexes
-- ============================================================================
