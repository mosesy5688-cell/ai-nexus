-- Migration number: 0017 	 2025-12-05T18:40:00.000Z
-- Description: Add Papers With Code fields for benchmarks and SOTA

-- Add columns for PWC data
ALTER TABLE models ADD COLUMN pwc_benchmarks TEXT; -- JSON array of benchmark objects
ALTER TABLE models ADD COLUMN pwc_tasks TEXT;      -- JSON array of task strings
ALTER TABLE models ADD COLUMN pwc_datasets TEXT;   -- JSON array of dataset strings
ALTER TABLE models ADD COLUMN pwc_sota_count INTEGER DEFAULT 0; -- Number of SOTA rankings
