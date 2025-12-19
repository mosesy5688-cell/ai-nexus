
-- Inspect DB State
SELECT name FROM sqlite_master WHERE type='table' AND name IN ('models', 'entities');
PRAGMA table_info(entities);
PRAGMA table_info(models);
