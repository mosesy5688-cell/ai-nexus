/**
 * V23.1 Shard DB Schemas
 * Extracted to satisfy CES Monolith Ban (Art 5.1).
 */

export const entitiesTableSql = `
    CREATE TABLE entities (
        id TEXT PRIMARY KEY, umid TEXT UNIQUE, slug TEXT, name TEXT, type TEXT, author TEXT, summary TEXT, 
        category TEXT, tags TEXT, fni_score REAL, fni_percentile TEXT,
        fni_p REAL DEFAULT 0, fni_f REAL DEFAULT 0, fni_v REAL DEFAULT 0, fni_c REAL DEFAULT 0, fni_u REAL DEFAULT 0, raw_pop REAL DEFAULT 0,
        params_billions REAL DEFAULT 0, architecture TEXT, context_length INTEGER DEFAULT 0,
        is_trending INTEGER DEFAULT 0, stars INTEGER, downloads INTEGER, 
        last_modified TEXT, bundle_key TEXT, bundle_offset INTEGER, bundle_size INTEGER, shard_hash TEXT, trend_7d TEXT,
        license TEXT, source_url TEXT, pipeline_tag TEXT, image_url TEXT, vram_estimate_gb REAL, source TEXT,
        task_categories TEXT, num_rows INTEGER DEFAULT 0, primary_language TEXT, forks INTEGER DEFAULT 0, citation_count INTEGER DEFAULT 0,
        runtime_hardware TEXT, vocab_size INTEGER DEFAULT 0, num_layers INTEGER DEFAULT 0, hidden_size INTEGER DEFAULT 0,
        datasets_used TEXT, quick_start TEXT,
        vram_fp16_gb REAL, vram_int8_gb REAL, vram_int4_gb REAL,
        readme_html TEXT, ui_related_mesh TEXT, search_vector TEXT,
        canonical_url TEXT, citation TEXT
    );

`;

export const dbSchemas = `
    ${entitiesTableSql}
    -- V23.1: Strict Contentless FTS5 with porter stemmer
    CREATE VIRTUAL TABLE search USING fts5(name, summary, author, tags, category, content='', tokenize='porter unicode61 remove_diacritics 2');
    CREATE TABLE site_metadata (key TEXT PRIMARY KEY, value TEXT);
    CREATE INDEX idx_fni ON entities(fni_score DESC, raw_pop DESC, slug ASC);
    CREATE INDEX idx_type ON entities(type);
    CREATE INDEX idx_umid ON entities(umid);
`;

/** V25.8: Standalone FTS5 database schema (decoupled from meta.db) */
export const ftsDbSchema = `
    CREATE VIRTUAL TABLE search USING fts5(
        umid, name, summary, author, tags, category,
        content='', tokenize='porter unicode61 remove_diacritics 2'
    );
    CREATE TABLE fts_metadata (key TEXT PRIMARY KEY, value TEXT);
`;

export const searchDbSchema = `
    ${entitiesTableSql}
    CREATE TABLE site_metadata (key TEXT PRIMARY KEY, value TEXT);
    CREATE INDEX idx_fni_full ON entities(fni_score DESC, raw_pop DESC, slug ASC);
`;
