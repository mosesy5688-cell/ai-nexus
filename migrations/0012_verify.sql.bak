-- Migration number: 0012 Verification
-- Description: Verify GitHub fields were added successfully
-- Date: 2025-12-04

-- Check schema includes new columns
PRAGMA table_info(models);

-- Check indexes
PRAGMA index_list('models');

-- Sample query to verify columns exist
SELECT 
    id, 
    name, 
    github_stars, 
    github_forks, 
    github_last_commit, 
    github_contributors
FROM models 
LIMIT 5;

-- Count models with GitHub data
SELECT 
    COUNT(*) as total_models,
    COUNT(github_stars) as models_with_github_data,
    ROUND(COUNT(github_stars) * 100.0 / COUNT(*), 2) as github_coverage_percentage
FROM models;
