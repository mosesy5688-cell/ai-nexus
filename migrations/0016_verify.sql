-- Verify Migration 0016: FTS5 Full-Text Search
-- Date: 2025-12-05
-- Purpose: Verify FTS5 table and triggers are working correctly

-- 1. Verify FTS5 table exists and has data
SELECT COUNT(*) as fts_rows FROM models_fts;

-- 2. Compare row counts (should match)
SELECT 
  (SELECT COUNT(*) FROM models) as models_count,
  (SELECT COUNT(*) FROM models_fts) as fts_count,
  CASE 
    WHEN (SELECT COUNT(*) FROM models) = (SELECT COUNT(*) FROM models_fts) 
    THEN 'PASS' 
    ELSE 'FAIL' 
  END as status;

-- 3. Test basic search functionality
SELECT 
  id, 
  name, 
  rank
FROM models_fts
WHERE models_fts MATCH 'language'
ORDER BY rank
LIMIT 5;

-- 4. Test phrase search
SELECT 
  id, 
  name, 
  rank
FROM models_fts
WHERE models_fts MATCH '"deep learning"'
ORDER BY rank
LIMIT 5;

-- 5. Test prefix search (partial word matching)
SELECT 
  id, 
  name, 
  rank
FROM models_fts
WHERE models_fts MATCH 'lang*'
ORDER BY rank
LIMIT 5;

-- 6. List all FTS5 related objects (should see table + triggers)
SELECT 
  name, 
  type,
  CASE type
    WHEN 'table' THEN '✓ Virtual Table'
    WHEN 'trigger' THEN '✓ Auto-sync Trigger'
    ELSE type
  END as description
FROM sqlite_master 
WHERE name LIKE 'models_fts%'
ORDER BY type, name;

-- 7. Test search performance (should be fast)
SELECT 
  COUNT(*) as total_matches
FROM models_fts
WHERE models_fts MATCH 'model OR tool OR learning';
