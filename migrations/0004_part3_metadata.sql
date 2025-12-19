-- Part 3: Add Metadata and Fix Type
ALTER TABLE entities ADD COLUMN metadata TEXT;
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
UPDATE entities SET type='model' WHERE type IS NULL;
