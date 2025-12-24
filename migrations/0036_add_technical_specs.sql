-- Migration: 0036 - Add Technical Specification Fields
-- Purpose: P2 Fix - Enable Technical Specs display on model detail pages
-- Fields: params_billions, context_length, architecture, hidden_size, num_layers
-- Required by: TechnicalSpecs.astro component

-- ============================================================
-- STEP 1: Add technical specification columns to entities
-- ============================================================

-- Model size in billions of parameters
ALTER TABLE entities ADD COLUMN params_billions REAL;

-- Context window size (max_position_embeddings)
ALTER TABLE entities ADD COLUMN context_length INTEGER;

-- Architecture name (e.g., LlamaForCausalLM, GPT2LMHeadModel)
ALTER TABLE entities ADD COLUMN architecture TEXT;

-- Model dimensions
ALTER TABLE entities ADD COLUMN hidden_size INTEGER;
ALTER TABLE entities ADD COLUMN num_layers INTEGER;

-- ============================================================
-- STEP 2: Create indexes for efficient filtering
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_entities_params ON entities(params_billions);
CREATE INDEX IF NOT EXISTS idx_entities_context ON entities(context_length);
CREATE INDEX IF NOT EXISTS idx_entities_architecture ON entities(architecture);

-- ============================================================
-- STEP 3: Also add to entities_lean if exists
-- ============================================================

-- For lean schema (if active)
ALTER TABLE entities_lean ADD COLUMN params_billions REAL;
ALTER TABLE entities_lean ADD COLUMN context_length INTEGER;
ALTER TABLE entities_lean ADD COLUMN architecture TEXT;
ALTER TABLE entities_lean ADD COLUMN hidden_size INTEGER;
ALTER TABLE entities_lean ADD COLUMN num_layers INTEGER;

-- ============================================================
-- NOTES:
-- - These columns are populated by L1 Harvester via buildMetaJson()
-- - L8 trending-generator.ts now includes these in trending.json
-- - TechnicalSpecs.astro reads from model props
-- ============================================================
