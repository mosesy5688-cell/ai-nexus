-- Migration number: 0018
-- Description: Create Knowledge Graph Edges Table
-- Date: 2025-12-05
-- Purpose: Store relationship edges between URNs (models, papers, datasets, etc.)

CREATE TABLE graph_edges (
    source TEXT NOT NULL,         -- Source URN (e.g., urn:model:meta-llama/Llama-2-7b)
    target TEXT NOT NULL,         -- Target URN (e.g., urn:author:meta)
    type TEXT NOT NULL,           -- Edge type (e.g., authored_by)
    weight REAL DEFAULT 1.0,      -- Connection strength
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (source, target, type)
);

-- Bidirectional indexes for fast traversal
CREATE INDEX idx_graph_source ON graph_edges(source);
CREATE INDEX idx_graph_target ON graph_edges(target);
CREATE INDEX idx_graph_type ON graph_edges(type);
