-- V4 Stable Execution Layer: A2 Unresolved Slugs Buffer
-- Constitution V4.3.2 Compliant
-- Purpose: Buffer for 404 slugs before writing to umid_resolver

CREATE TABLE IF NOT EXISTS unresolved_slugs (
    slug TEXT PRIMARY KEY,
    first_seen TEXT DEFAULT CURRENT_TIMESTAMP,
    hit_count INTEGER DEFAULT 1,
    source_page TEXT,
    last_seen TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Index for efficient daily processing
CREATE INDEX IF NOT EXISTS idx_unresolved_hit ON unresolved_slugs(hit_count);
