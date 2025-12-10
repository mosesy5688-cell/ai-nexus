-- V4.1 Migration: Add workflow_logs monitoring table
-- Purpose: Track all Unified Workflow executions for observability

CREATE TABLE IF NOT EXISTS workflow_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL,
  workflow_type TEXT NOT NULL,  -- 'ingest', 'fni', 'unified', 'guardian'
  status TEXT NOT NULL,         -- 'started', 'completed', 'failed'
  processed_count INTEGER DEFAULT 0,
  error_message TEXT,
  duration_ms INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Index for querying recent logs
CREATE INDEX IF NOT EXISTS idx_workflow_logs_created_at ON workflow_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_logs_type ON workflow_logs(workflow_type);
