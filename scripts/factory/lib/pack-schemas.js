/**
 * V23.1 Shard DB Schemas
 * Extracted to satisfy CES Monolith Ban (Art 5.1).
 */

export const entitiesTableSql = `
    CREATE TABLE entities (
        id TEXT PRIMARY KEY, umid TEXT UNIQUE, slug TEXT, name TEXT, type TEXT, author TEXT, summary TEXT, 
        category TEXT, tags TEXT, fni_score REAL, fni_percentile TEXT,
        fni_p REAL DEFAULT 0, fni_v REAL DEFAULT 0, fni_c REAL DEFAULT 0, fni_u REAL DEFAULT 0,
        params_billions REAL DEFAULT 0, architecture TEXT, context_length INTEGER DEFAULT 0,
        is_trending INTEGER DEFAULT 0, stars INTEGER, downloads INTEGER, 
        last_modified TEXT, bundle_key TEXT, bundle_offset INTEGER, bundle_size INTEGER, shard_hash TEXT, trend_7d TEXT,
        license TEXT, source_url TEXT, pipeline_tag TEXT, image_url TEXT, vram_estimate_gb REAL, source TEXT
    );
`;

export const dbSchemas = `
    ${entitiesTableSql}
    -- V23.1: Strict Contentless FTS5 with porter stemmer
    CREATE VIRTUAL TABLE search USING fts5(name, summary, author, tags, category, content='', tokenize='porter unicode61 remove_diacritics 2');
    CREATE TABLE site_metadata (key TEXT PRIMARY KEY, value TEXT);
    CREATE INDEX idx_fni ON entities(fni_score DESC);
    CREATE INDEX idx_type ON entities(type);
`;

export const searchDbSchema = `
    ${entitiesTableSql}
    CREATE TABLE site_metadata (key TEXT PRIMARY KEY, value TEXT);
    CREATE INDEX idx_fni_full ON entities(fni_score DESC);
`;
