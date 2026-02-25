/**
 * V22.8: VFS SQLite Schemas and Setup
 */
export const META_SCHEMA = `
    CREATE TABLE entities (
        id TEXT PRIMARY KEY, umid TEXT UNIQUE, slug TEXT, name TEXT, type TEXT, author TEXT, summary TEXT, 
        category TEXT, tags TEXT, fni_score REAL, fni_percentile TEXT,
        fni_p REAL DEFAULT 0, fni_v REAL DEFAULT 0, fni_c REAL DEFAULT 0, fni_u REAL DEFAULT 0,
        params_billions REAL DEFAULT 0,
        architecture TEXT,
        context_length INTEGER DEFAULT 0,
        is_trending INTEGER DEFAULT 0, stars INTEGER, downloads INTEGER, 
        last_modified TEXT, bundle_key TEXT, bundle_offset INTEGER, bundle_size INTEGER, shard_hash TEXT, trend_7d TEXT,
        license TEXT DEFAULT '', source_url TEXT DEFAULT '', pipeline_tag TEXT DEFAULT '',
        image_url TEXT DEFAULT '', vram_estimate_gb REAL DEFAULT 0, source TEXT DEFAULT ''
    );
    -- V22.6: Strictly Contentless FTS5 (content='')
    CREATE VIRTUAL TABLE search USING fts5(name, summary, author, tags, category, content='', tokenize='unicode61 remove_diacritics 2');
    CREATE TABLE site_metadata (key TEXT PRIMARY KEY, value TEXT);
    CREATE INDEX idx_fni ON entities(fni_score DESC);
    CREATE INDEX idx_type ON entities(type);
`;

export const SEARCH_SCHEMA = `
    CREATE TABLE entities (
        id TEXT PRIMARY KEY, umid TEXT UNIQUE, slug TEXT, name TEXT, type TEXT, author TEXT, summary TEXT, 
        category TEXT, tags TEXT, fni_score REAL, fni_percentile TEXT,
        fni_p REAL DEFAULT 0, fni_v REAL DEFAULT 0, fni_c REAL DEFAULT 0, fni_u REAL DEFAULT 0,
        params_billions REAL DEFAULT 0,
        architecture TEXT,
        context_length INTEGER DEFAULT 0,
        is_trending INTEGER DEFAULT 0, stars INTEGER, downloads INTEGER, 
        last_modified TEXT, bundle_key TEXT, bundle_offset INTEGER, bundle_size INTEGER, shard_hash TEXT, trend_7d TEXT,
        license TEXT DEFAULT '', source_url TEXT DEFAULT '', pipeline_tag TEXT DEFAULT '',
        image_url TEXT DEFAULT '', vram_estimate_gb REAL DEFAULT 0, source TEXT DEFAULT ''
    );
    CREATE TABLE site_metadata (key TEXT PRIMARY KEY, value TEXT);
    CREATE INDEX idx_fni_full ON entities(fni_score DESC);
`;

export function setupDb(db) {
    db.pragma('page_size = 8192'); // V22.0 High-Density 8K Alignment
    db.pragma('auto_vacuum = 0');
    db.pragma('journal_mode = DELETE');
    db.pragma('synchronous = OFF');
    db.pragma('encoding = "UTF-8"');
}
