/**
 * V23.1 Shard DB Schemas
 * Extracted to satisfy CES Monolith Ban (Art 5.1).
 */

// V27.45: honest-contract 0-vs-null compliance per llms.txt:
//   "Field semantics: `0` means measured-zero, `null` means not-measured.
//    Treat them differently when scoring downstream."
// Removed `DEFAULT 0` from numeric columns that semantically should preserve null
// when the source data didn't have the value (vs measured-zero). FNI factor + raw_pop
// keep DEFAULT 0 because they ARE always computed (zero is meaningful, not unknown).
// is_trending / has_fulltext / ollama_compatible / can_run_local are tri-state booleans
// where the 0/1 semantic is intentional (handled by the caller).
export const entitiesTableSql = `
    CREATE TABLE entities (
        id TEXT PRIMARY KEY, umid TEXT UNIQUE, slug TEXT, name TEXT, type TEXT, author TEXT, summary TEXT,
        category TEXT, tags TEXT, fni_score REAL, fni_percentile TEXT,
        fni_s REAL DEFAULT 0, fni_a REAL DEFAULT 0, fni_p REAL DEFAULT 0, fni_r REAL DEFAULT 0, fni_q REAL DEFAULT 0, raw_pop REAL DEFAULT 0,
        params_billions REAL, architecture TEXT, context_length INTEGER,
        is_trending INTEGER DEFAULT 0, stars INTEGER, downloads INTEGER,
        last_modified TEXT, bundle_key TEXT, bundle_offset INTEGER, bundle_size INTEGER, trend_7d TEXT,
        license TEXT, source_url TEXT, pipeline_tag TEXT, image_url TEXT, vram_estimate_gb REAL, source TEXT,
        task_categories TEXT, num_rows INTEGER, primary_language TEXT, forks INTEGER, citation_count INTEGER,
        runtime_hardware TEXT, vocab_size INTEGER, num_layers INTEGER, hidden_size INTEGER,
        datasets_used TEXT, quick_start TEXT,
        vram_fp16_gb REAL, vram_int8_gb REAL, vram_int4_gb REAL,
        readme_html TEXT, ui_related_mesh TEXT, search_vector TEXT,
        canonical_url TEXT, citation TEXT,
        has_fulltext INTEGER DEFAULT 0,
        ollama_compatible INTEGER DEFAULT 0,
        hosted_on TEXT DEFAULT '[]',
        license_type TEXT DEFAULT 'unknown',
        can_run_local INTEGER DEFAULT 0,
        hosted_on_checked_at TEXT,
        benchmarks TEXT,
        num_heads INTEGER, kv_heads INTEGER, moe_experts INTEGER, moe_active INTEGER,
        sdk TEXT, running_status TEXT, size_category TEXT, files_count INTEGER,
        modality TEXT, published_year INTEGER, primary_category TEXT
    );

`;

export const dbSchemas = `
    ${entitiesTableSql}
    CREATE TABLE site_metadata (key TEXT PRIMARY KEY, value TEXT);
    CREATE INDEX idx_fni ON entities(fni_score DESC, raw_pop DESC, slug ASC);
    CREATE INDEX idx_type ON entities(type);
    CREATE INDEX idx_umid ON entities(umid);
    CREATE INDEX idx_bundle ON entities(bundle_key);
    CREATE INDEX idx_license_type ON entities(license_type);
    CREATE INDEX idx_ollama ON entities(ollama_compatible);
`;

// V26.5: searchDbSchema removed — search.db eliminated. All consumers read meta-NN.db.
// V27.104: ftsDbSchema removed — fts.db eliminated (no live reader; keyword search is the
// static inverted index term_index/, not FTS5). Schema was the standalone FTS5 `search` table.
