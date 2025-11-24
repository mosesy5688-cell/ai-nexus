-- Migration number: 0003 	 2025-11-24T00:00:00.000Z
-- Description: Add resources column for rich source data preservation

ALTER TABLE models ADD COLUMN resources TEXT;
