/**
 * V4.3.1 UMID Backfill Script
 * 
 * This script generates UMIDs for all existing models in D1.
 * Run with: npx wrangler d1 execute ai-nexus-db --remote --file=scripts/umid-backfill.sql
 */

-- Step 1: Generate canonical_name from model name
-- Format: lowercase, replace special chars with hyphens, remove duplicates
UPDATE models 
SET canonical_name = LOWER(
    REPLACE(
        REPLACE(
            REPLACE(
                REPLACE(
                    REPLACE(name, '/', '-'),
                    ' ', '-'
                ),
                '_', '-'
            ),
            '.', '-'
        ),
        '--', '-'
    )
)
WHERE canonical_name IS NULL;

-- Step 2: Extract arxiv_id from ArXiv model IDs
UPDATE models 
SET arxiv_id = SUBSTR(id, 7)  -- Remove 'arxiv:' prefix
WHERE source = 'arxiv' 
  AND (arxiv_id IS NULL OR arxiv_id = '')
  AND id LIKE 'arxiv:%';

-- Step 3: Generate UMID - using hash of canonical_name + author + source
-- SQLite doesn't have native hash, so we use a deterministic formula
-- UMID format: umid_ + first 16 chars of hex(canonical_name + author + source)
UPDATE models 
SET umid = 'umid_' || SUBSTR(
    LOWER(HEX(canonical_name || COALESCE(author, '') || COALESCE(source, ''))),
    1, 16
)
WHERE umid IS NULL;

-- Step 4: Set umid_version for all records
UPDATE models 
SET umid_version = 'v1'
WHERE umid_version IS NULL;

-- Step 5: Generate author_fingerprint
UPDATE models 
SET author_fingerprint = SUBSTR(
    LOWER(HEX(COALESCE(author, '') || COALESCE(source, ''))),
    1, 8
)
WHERE author_fingerprint IS NULL;
