-- ============================================================
-- Migration: 0021_schema_v3_2.sql
-- V3.2 Universal Standard Schema Upgrade
-- ============================================================
-- Purpose: Add support for complete data collection, digital asset
-- ownership, quality scoring, and knowledge graph relationships.
-- ============================================================

-- ============================================================
-- SECTION 1: Core Entity Fields
-- ============================================================

-- Entity type classification (model/paper/dataset/tool/space)
ALTER TABLE models ADD COLUMN type TEXT DEFAULT 'model';

-- Complete README/documentation content (self-hosted, not external link)
ALTER TABLE models ADD COLUMN body_content TEXT;

-- Extended metadata (params, framework, context_length, etc.)
ALTER TABLE models ADD COLUMN meta_json TEXT;

-- Asset list for the entity [{type, local_path, size}]
ALTER TABLE models ADD COLUMN assets_json TEXT;

-- ============================================================
-- SECTION 2: Relationships & Deduplication
-- ============================================================

-- Knowledge graph relationships [{type, target_id}]
ALTER TABLE models ADD COLUMN relations_json TEXT;

-- Points to canonical/primary record ID for deduplication
ALTER TABLE models ADD COLUMN canonical_id TEXT;

-- ============================================================
-- SECTION 3: Compliance & Quality
-- ============================================================

-- Standardized SPDX license identifier
ALTER TABLE models ADD COLUMN license_spdx TEXT;

-- Compliance status: 'approved', 'pending', 'flagged', 'blocked'
ALTER TABLE models ADD COLUMN compliance_status TEXT DEFAULT 'pending';

-- Quality score (0-100) based on content completeness, assets, popularity
ALTER TABLE models ADD COLUMN quality_score FLOAT;

-- ============================================================
-- SECTION 4: Performance Optimization
-- ============================================================

-- Content hash for incremental update optimization (skip unchanged)
ALTER TABLE models ADD COLUMN content_hash TEXT;

-- 7-day growth velocity for trending calculations
ALTER TABLE models ADD COLUMN velocity FLOAT;

-- Original image URL before processing (for re-processing if needed)
ALTER TABLE models ADD COLUMN raw_image_url TEXT;

-- ============================================================
-- SECTION 5: Indexes for Performance
-- ============================================================

-- Type-based filtering
CREATE INDEX IF NOT EXISTS idx_models_type ON models(type);

-- Content hash lookup for skip-unchanged optimization
CREATE INDEX IF NOT EXISTS idx_models_content_hash ON models(content_hash);

-- Compliance status filtering
CREATE INDEX IF NOT EXISTS idx_models_compliance ON models(compliance_status);

-- Canonical ID for deduplication queries
CREATE INDEX IF NOT EXISTS idx_models_canonical ON models(canonical_id);

-- Quality-based sorting (descending for "best first")
CREATE INDEX IF NOT EXISTS idx_models_quality ON models(quality_score DESC);

-- License-based filtering
CREATE INDEX IF NOT EXISTS idx_models_license ON models(license_spdx);

-- ============================================================
-- SECTION 6: Future Entity Tables (Prepared for V3.3+)
-- ============================================================

-- Note: papers, datasets tables were created in 0020_schema_v3_1.sql
-- Adding indexes for existing columns

CREATE INDEX IF NOT EXISTS idx_papers_arxiv ON papers(arxiv_id);
CREATE INDEX IF NOT EXISTS idx_datasets_author ON datasets(author);

-- ============================================================
-- SUMMARY
-- ============================================================
-- New columns added to models table:
-- 1. type (TEXT) - Entity classification
-- 2. body_content (TEXT) - Complete README content
-- 3. meta_json (TEXT) - Extended metadata JSON
-- 4. assets_json (TEXT) - Asset list JSON
-- 5. relations_json (TEXT) - Knowledge graph relationships
-- 6. canonical_id (TEXT) - Deduplication reference
-- 7. license_spdx (TEXT) - Standardized license
-- 8. compliance_status (TEXT) - Content compliance
-- 9. quality_score (FLOAT) - Quality rating
-- 10. content_hash (TEXT) - Change detection
-- 11. velocity (FLOAT) - Growth metric
-- 12. raw_image_url (TEXT) - Original image URL
-- ============================================================
