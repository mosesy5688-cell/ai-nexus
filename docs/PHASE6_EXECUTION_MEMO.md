# Phase 6: Atomic V2.0 Upgrade — Execution Memo

**Date**: 2026-04-03
**PR**: #1664 (`feat/phase6-atomic-v2-upgrade`)
**Commits**: 3 (factory+backend, UI components, transition safety fix)

## Scope

| Module | Change |
|--------|--------|
| Embedding Model (Factory) | `Xenova/all-MiniLM-L6-v2` (384d) → `Xenova/bge-base-en-v1.5` (768d) |
| Embedding Model (SSR) | `@cf/baai/bge-small-en-v1.5` → `@cf/baai/bge-base-en-v1.5` |
| FNI Formula | V18.9 `(Sp×0.45 + Sf×0.30 + Sm×0.25)` → V2.0 `(S×0.35 + A×0.25 + P×0.15 + R×0.15 + Q×0.10)` |
| FNI Metric Keys | `(p, f, v, c, u)` → `(s, a, p, r, q)` |
| Cluster ANN | New k-means 128-cluster index builder |
| Sanity Checks | Thresholds updated for V2.0 baseline (S=50 default) |

## Files Modified (30+)

### Factory (scripts/)
- `embedding-generator.js` — model + dim
- `fni-score.js` — complete V2.0 rewrite
- `cluster-ann-builder.js` — NEW, k-means++ ANN index
- `pack-db.js` — model ref + ANN build step
- `fni-sanity-check.js` — thresholds for V2.0
- `pack-schemas.js`, `row-builders.js`, `v25-distiller.js` — column/key renames
- `vector-core-generator.js`, `shard-writer.js` — 768d
- `embedding-cache.js` — auto-wipe on model mismatch
- `search-indexer.js`, `parquet-exporter.js`, `processor-core.js` — metric keys
- `registry-loader.js`, `rankings-generator.js`, `trending-generator.js` — metric keys

### Rust FFI
- `rust/stream-aggregator/src/project.rs` — metric keys
- `rust/satellite-tasks/src/search_indexer.rs` — metric keys

### SSR / API
- `src/lib/semantic-engine.ts` — 768d model, dynamic header read, scanDim transition safety
- `src/pages/api/v1/search.ts` — API version tag
- `src/pages/api/mcp.ts` — factor descriptions

### Frontend Utils
- `src/scripts/lib/DataNormalizer.js`, `src/utils/ranking-utils.ts` — V2.0 keys
- `src/utils/entity-hydrator.js`, `src/utils/dual-engine-merger.ts` — field mappings
- `src/utils/builders/model-getters.js` — buildFNI()

### Frontend UI Components
- `FNITrustPanel.astro` — 5-bar chart (S/A/P/R/Q), V2.0 badge
- `FNIBadge.astro` — 5-column tooltip
- `EntityMetricGrid.astro` — S/A/P/R/Q bars
- `EntityHeader.astro` — prop pass-through
- `FNIDimensionFilter.astro` — 6 sort dimensions

### Page Templates (7)
- `agent/[...slug].astro`, `dataset/[...slug].astro`, `model/[...slug].astro`
- `paper/[...slug].astro`, `prompt/[...slug].astro`, `space/[...slug].astro`
- `tool/[...slug].astro`

### Config
- `scripts/fni/fni-config.js`, `scripts/fni/fni-calc.js`, `scripts/calculate-fni.js`

## Transition Safety

**Problem**: After code deploy but before next 4/4 factory run, `vector-core.bin` in R2 is still 384d while SSR Workers AI outputs 768d query embeddings.

**Solution** (Commit 3):
- `VECTOR_DIMENSIONS` and `RECORD_SIZE` read from vector-core.bin header at load time
- `scanDim = Math.min(queryEmbedding.length, VECTOR_DIMENSIONS)` truncates comparison
- All scan loops use `scanDim`, not `VECTOR_DIMENSIONS`
- **Result**: SSR auto-adapts — no code change needed when 4/4 produces 768d data

| Phase | vector-core.bin | scanDim | Status |
|-------|----------------|---------|--------|
| Pre-4/4 (now) | 384d header | min(768,384)=384 | Works (truncated) |
| Post-4/4 | 768d header | min(768,768)=768 | Works (full precision) |

## Post-Merge Checklist

- [ ] Merge PR #1664 to main
- [ ] Verify Cloudflare Pages deploy succeeds
- [ ] Run next 4/4 factory (`npm run factory`) to produce 768d vectors + V2.0 FNI scores
- [ ] Verify `vector-core.bin` header shows dim=768 after upload
- [ ] Spot-check semantic search results in production
- [ ] Verify FNI scores on entity detail pages show S/A/P/R/Q breakdown
