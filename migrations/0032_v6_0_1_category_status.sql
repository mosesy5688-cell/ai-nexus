-- V6.0.1: Add category_status column for transparent classification tracking
-- Constitution V5.2.1 Art 6.1: Category = Verifiable Fact Only
-- "classified" = has valid pipeline_tag from upstream API
-- "pending_classification" = awaiting semantic inference in V6.1

ALTER TABLE models ADD COLUMN category_status TEXT DEFAULT 'pending_classification';

-- Migrate existing data: set status based on current category_confidence
-- Models with high confidence = classified, others = pending
UPDATE models 
SET category_status = CASE 
    WHEN category_confidence = 'high' THEN 'classified' 
    ELSE 'pending_classification' 
END;

-- Create index for efficient filtering
CREATE INDEX IF NOT EXISTS idx_models_category_status ON models(category_status);
