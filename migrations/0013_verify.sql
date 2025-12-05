-- Verify Migration 0013: Check ArXiv fields
-- Date: 2025-12-04
-- Purpose: Verify ArXiv metadata schema and enrichment status

-- 1. Verify columns exist
PRAGMA table_info(models);

-- 2. Check enrichment statistics
SELECT 
  COUNT(*) as total_models,
  COUNT(arxiv_id) as with_arxiv_id,
  COUNT(CASE WHEN arxiv_id IS NOT NULL AND arxiv_id != '' THEN 1 END) as enriched,
  ROUND(COUNT(CASE WHEN arxiv_id IS NOT NULL AND arxiv_id != '' THEN 1 END) * 100.0 / COUNT(*), 2) as enrichment_pct
FROM models;

-- 3. Check models with ArXiv references in source_url
SELECT 
  COUNT(*) as potential_arxiv_models
FROM models
WHERE source_url LIKE '%arxiv.org%'
   OR description LIKE '%arXiv:%'
   OR description LIKE '%arxiv.org%';

-- 4. Sample enriched records
SELECT 
  id,
  name,
  arxiv_id,
  arxiv_category,
  arxiv_published,
  source_url
FROM models 
WHERE arxiv_id IS NOT NULL AND arxiv_id != ''
LIMIT 5;

-- 5. Category distribution
SELECT 
  arxiv_category,
  COUNT(*) as count
FROM models
WHERE arxiv_category IS NOT NULL
GROUP BY arxiv_category
ORDER BY count DESC
LIMIT 10;
