-- Part 2: Add Columns
ALTER TABLE entities ADD COLUMN type TEXT DEFAULT 'model';
ALTER TABLE entities ADD COLUMN metadata TEXT;
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
