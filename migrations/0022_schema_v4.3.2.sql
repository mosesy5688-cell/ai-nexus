-- ============================================================
-- V4.3.2 SCHEMA MIGRATION
-- Purpose: Data Source Expansion - Benchmarks, Specs, Citations
-- Date: 2025-12-11
-- Constitution: V4.3.2 Final
-- ============================================================

-- ============================================================
-- NEW TABLE 1: model_benchmarks
-- Source: Open LLM Leaderboard
-- ============================================================
CREATE TABLE IF NOT EXISTS model_benchmarks (
  umid TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'open_llm_leaderboard',
  mmlu REAL,
  humaneval REAL,
  truthfulqa REAL,
  hellaswag REAL,
  arc_challenge REAL,
  winogrande REAL,
  gsm8k REAL,
  avg_score REAL,
  quality_flag TEXT DEFAULT 'ok',
  eval_meta TEXT,
  last_updated TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bench_source ON model_benchmarks(source);
CREATE INDEX IF NOT EXISTS idx_bench_avg ON model_benchmarks(avg_score DESC);
CREATE INDEX IF NOT EXISTS idx_bench_quality ON model_benchmarks(quality_flag);

-- ============================================================
-- NEW TABLE 2: model_specs
-- Source: HuggingFace config.json
-- ============================================================
CREATE TABLE IF NOT EXISTS model_specs (
  umid TEXT PRIMARY KEY,
  params_billions REAL,
  context_length INTEGER,
  vocab_size INTEGER,
  hidden_size INTEGER,
  num_layers INTEGER,
  architecture TEXT,
  architecture_family TEXT,
  base_model_umid TEXT,
  quantization_formats TEXT,
  config_json TEXT,
  deploy_score REAL DEFAULT 0,
  last_updated TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_specs_params ON model_specs(params_billions);
CREATE INDEX IF NOT EXISTS idx_specs_arch ON model_specs(architecture_family);
CREATE INDEX IF NOT EXISTS idx_specs_deploy ON model_specs(deploy_score DESC);
CREATE INDEX IF NOT EXISTS idx_specs_base ON model_specs(base_model_umid);

-- ============================================================
-- NEW TABLE 3: model_citations
-- Source: Semantic Scholar, PapersWithCode
-- ============================================================
CREATE TABLE IF NOT EXISTS model_citations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  umid TEXT NOT NULL,
  paper_id TEXT,
  paper_version TEXT,
  title TEXT,
  citation_count INTEGER DEFAULT 0,
  influential_citation_count INTEGER DEFAULT 0,
  source TEXT,
  last_checked TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(umid, paper_id)
);

CREATE INDEX IF NOT EXISTS idx_citations_umid ON model_citations(umid);
CREATE INDEX IF NOT EXISTS idx_citations_count ON model_citations(citation_count DESC);

-- ============================================================
-- MODELS TABLE EXTENSIONS
-- Note: SQLite requires separate ALTER statements
-- ============================================================

-- V4.3.2 Extension columns (run individually, skip if exists)
-- ALTER TABLE models ADD COLUMN has_benchmarks BOOLEAN DEFAULT FALSE;
-- ALTER TABLE models ADD COLUMN params_billions REAL;
-- ALTER TABLE models ADD COLUMN context_length INTEGER;
-- ALTER TABLE models ADD COLUMN architecture_family TEXT;
-- ALTER TABLE models ADD COLUMN base_model_umid TEXT;
-- ALTER TABLE models ADD COLUMN deploy_score REAL DEFAULT 0;

-- ============================================================
-- VERIFICATION QUERY
-- ============================================================
-- SELECT name FROM sqlite_master WHERE type='table' 
-- AND name IN ('model_benchmarks', 'model_specs', 'model_citations');
