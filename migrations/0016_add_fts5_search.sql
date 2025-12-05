-- Migration 0016: Add FTS5 Full-Text Search
-- Date: 2025-12-05
-- Purpose: Enable powerful full-text search across model data

-- Create FTS5 virtual table for full-text search
-- Using external content table pattern to avoid data duplication
CREATE VIRTUAL TABLE models_fts USING fts5(
  id UNINDEXED,           -- Don't index (used for JOIN only)
  name,                   -- Searchable: model name
  author,                 -- Searchable: author name
  description,            -- Searchable: full description
  tags,                   -- Searchable: tags (as stored string)
  pipeline_tag,           -- Searchable: category/pipeline
  content='models',       -- External content table (links to models)
  content_rowid='rowid',  -- Link via rowid
  tokenize='porter unicode61'  -- Porter stemmer + Unicode support
);

-- Populate FTS5 table with existing data
INSERT INTO models_fts(rowid, id, name, author, description, tags, pipeline_tag)
SELECT rowid, id, name, author, description, tags, pipeline_tag
FROM models;

-- Create triggers to keep FTS5 in sync with models table
-- Trigger 1: On INSERT
CREATE TRIGGER models_fts_insert AFTER INSERT ON models BEGIN
  INSERT INTO models_fts(rowid, id, name, author, description, tags, pipeline_tag)
  VALUES (NEW.rowid, NEW.id, NEW.name, NEW.author, NEW.description, NEW.tags, NEW.pipeline_tag);
END;

-- Trigger 2: On UPDATE
CREATE TRIGGER models_fts_update AFTER UPDATE ON models BEGIN
  UPDATE models_fts 
  SET name = NEW.name,
      author = NEW.author,
      description = NEW.description,
      tags = NEW.tags,
      pipeline_tag = NEW.pipeline_tag
  WHERE rowid = OLD.rowid;
END;

-- Trigger 3: On DELETE
CREATE TRIGGER models_fts_delete AFTER DELETE ON models BEGIN
  DELETE FROM models_fts WHERE rowid = OLD.rowid;
END;

-- Verify FTS5 objects created
SELECT name, type 
FROM sqlite_master 
WHERE name LIKE 'models_fts%'
ORDER BY type, name;
