-- 4_populate_from_models.sql
-- Populate umid_resolver from existing models table
-- Run after 0024_umid_resolver.sql migration
-- NOTE: D1 does not support explicit transactions in SQL files

-- Map bench-style labels (normalize name to bench umid format)
INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence, created_at, updated_at)
SELECT 
  'bench', 
  LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(name, '/', '-'), ' ', '-'), '.', '-'), '--', '-'), '_', '-')), 
  umid, 
  1.0, 
  datetime('now'), 
  datetime('now')
FROM models 
WHERE umid IS NOT NULL AND umid != '';

-- Map huggingface id -> umid (direct mapping)
INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence, created_at, updated_at)
SELECT 'huggingface', id, umid, 1.0, datetime('now'), datetime('now')
FROM models 
WHERE id IS NOT NULL AND umid IS NOT NULL AND umid != '';

-- Map canonical_name -> umid
INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence, created_at, updated_at)
SELECT 'canonical', LOWER(canonical_name), umid, 1.0, datetime('now'), datetime('now')
FROM models 
WHERE canonical_name IS NOT NULL AND umid IS NOT NULL AND umid != '';

-- Map slug -> umid (if slug exists)
INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence, created_at, updated_at)
SELECT 'slug', LOWER(slug), umid, 1.0, datetime('now'), datetime('now')
FROM models 
WHERE slug IS NOT NULL AND slug != '' AND umid IS NOT NULL AND umid != '';

-- Map github repo -> umid
INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence, created_at, updated_at)
SELECT 'github', github_repo, umid, 1.0, datetime('now'), datetime('now')
FROM models 
WHERE github_repo IS NOT NULL AND github_repo != '' AND umid IS NOT NULL AND umid != '';

-- Map arxiv id -> umid
INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence, created_at, updated_at)
SELECT 'arxiv', arxiv_id, umid, 1.0, datetime('now'), datetime('now')
FROM models 
WHERE arxiv_id IS NOT NULL AND arxiv_id != '' AND umid IS NOT NULL AND umid != '';
