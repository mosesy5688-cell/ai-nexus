-- V4.1 Migration: Add models_history table for FNI Velocity calculation
-- Pillar VII (Fair Index): Enables 7-day growth trend tracking

-- History table for tracking model metrics over time
CREATE TABLE IF NOT EXISTS models_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id TEXT NOT NULL,
    downloads INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    recorded_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Index for efficient lookups by model and date
CREATE INDEX IF NOT EXISTS idx_history_model_date ON models_history(model_id, recorded_at);

-- Index for cleanup queries
CREATE INDEX IF NOT EXISTS idx_history_date ON models_history(recorded_at);
