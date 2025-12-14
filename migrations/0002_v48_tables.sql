-- V4.8 Constitutional Tables
-- Art.Shadow: Shadow DB for unverified models
-- Art.IX-Guardian: Quarantine log

CREATE TABLE IF NOT EXISTS models_shadow (
    id TEXT PRIMARY KEY,
    slug TEXT,
    name TEXT,
    author TEXT,
    source TEXT,
    reason TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS quarantine_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_ip TEXT,
    pattern TEXT,
    blocked_reason TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
