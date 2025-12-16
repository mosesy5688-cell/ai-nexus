# 🏛️ Free2AITools V4.3.2 Constitution

**Final Architecture Blueprint — Project Highest Law**

| Property | Value |
|----------|-------|
| Version | 4.3.2-final |
| Status | ✅ APPROVED |
| Effective Date | 2025-12-11 |
| Reviewed By | Chief Systems Architect (External Expert) |

---

## ❗ Amendment Notice (V4.3.2)

This Constitution upgrades V4.3.1 with **Data Source Expansion** capabilities:

- **Multi-channel UMID matching** — Name + Author + Params + Architecture alignment
- **Benchmark Plausibility Gate** — Quality filtering for leaderboard data
- **Deployability Index** — User retention through "can I run it" scoring
- **FNI Stability Alerts** — Prevent ranking collapse from data anomalies
- **Extended Precompute** — specs.json + benchmarks.json for frontend

> V4.3.2 is fully backward compatible with V4.3.1.

---

## 📋 Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| V4.3.1 | 2025-12-11 | UMID versioning, Synthetic APIs, Entity threshold | Superseded |
| V4.3.2 | 2025-12-11 | +Data Expansion, +Benchmarks, +Deep Specs | ✅ ACTIVE |

---

## 🎯 Executive Summary (V4.3.2)

| Gap | V4.3.1 Solution | V4.3.2 Enhancement |
|-----|-----------------|-------------------|
| FNI Credibility | Source quality | +Benchmark scores |
| FNI Utility | has_ollama/gguf | +Deployability Index |
| Neural Explorer | entity_links | +Architecture family + params |
| Detail Pages | Basic metadata | +Full specs + benchmarks |
| Rankings | Basic sorting | +Leaderboard with benchmarks |

---

# Part 1: The Nine Pillars (V4.3.2)

## Pillar I–IX: Inherited from V4.3.1

All nine pillars remain unchanged. V4.3.2 extends them with:

| Pillar | Principle | V4.3.2 Key |
|--------|-----------|------------|
| **I** | Elastic Infrastructure | Synthetic APIs + specs/bench cache |
| **II** | Credible Audit | UMID + multi-channel matching |
| **III** | Data Integrity | +Benchmark Plausibility Gate |
| **IV** | Hyper-Automation | 9-Loop + L8 extension |
| **V** | Open Ecosystem | Schema V4.3.2 (9 tables) |
| **VI** | Contextual Commerce | HMAC-signed affiliate links |
| **VII** | Fair Index | FNI from benchmarks + deploy_score |
| **VIII** | Cloud-Native | L1→R2, L2/L3→D1 |
| **IX** | SEO Ready | JSON-LD on all pages |

---

# Part 2: Data Source Hierarchy (NEW in V4.3.2)

## 2.1 Priority Matrix

### 🔴 Tier-1 P0 (Phase 2 Immediate)

| Source | Impact | FNI Boost |
|--------|--------|-----------|
| Open LLM Leaderboard | Benchmarks, Rankings | C +0.25, U +0.15 |
| HF Deep Spec Extractor | Params, Architecture | U +0.20 |

### 🟡 Tier-1 P1 (Phase 2 Week 3-4)

| Source | Impact |
|--------|--------|
| PapersWithCode SOTA | Paper↔Code links |
| Semantic Scholar | Citation counts |
| Replicate | Deploy examples |

### 🟢 Tier-2 P2 (Phase 3)

LangChain Hub, OpenRouter, GitHub Trending, Kaggle, GGUF Registry, Ollama

## 2.2 Active Sources (V4.3.2)

| # | Source | Status | NSFW Gate |
|---|--------|--------|-----------|
| 1 | HuggingFace | ✅ Production | N/A |
| 2 | HuggingFace Datasets | ✅ Production | N/A |
| 3 | GitHub | ✅ Production | N/A |
| 4 | ArXiv | ✅ Production | N/A |
| 5 | Papers With Code | ✅ Production | N/A |
| 6 | Ollama | ✅ Production | N/A |
| 7 | CivitAI | ✅ Production | L2 Verified |
| 8 | Open LLM Leaderboard | 🔜 P0 | N/A |
| 9 | HF Deep Spec | 🔜 P0 | N/A |

---

# Part 3: Schema V4.3.2

## 3.1 New Tables

### model_benchmarks

```sql
CREATE TABLE IF NOT EXISTS model_benchmarks (
  umid TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  mmlu REAL,
  humaneval REAL,
  truthfulqa REAL,
  hellaswag REAL,
  arc_challenge REAL,
  winogrande REAL,
  gsm8k REAL,
  avg_score REAL,
  quality_flag TEXT DEFAULT 'ok',  -- V4.3.2: 'ok'|'suspect'|'invalid'
  eval_meta TEXT,
  last_updated TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_bench_avg ON model_benchmarks(avg_score DESC);
```

### model_specs

```sql
CREATE TABLE IF NOT EXISTS model_specs (
  umid TEXT PRIMARY KEY,
  params_billions REAL,
  context_length INTEGER,
  vocab_size INTEGER,
  hidden_size INTEGER,
  num_layers INTEGER,
  architecture TEXT,
  architecture_family TEXT,        -- V4.3.2: llama, qwen, mistral, etc.
  base_model_umid TEXT,
  quantization_formats TEXT,
  config_json TEXT,
  deploy_score REAL,               -- V4.3.2: 0-1 deployability
  last_updated TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_specs_params ON model_specs(params_billions);
CREATE INDEX idx_specs_deploy ON model_specs(deploy_score DESC);
```

### model_citations

```sql
CREATE TABLE IF NOT EXISTS model_citations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  umid TEXT NOT NULL,
  paper_id TEXT,
  paper_version TEXT,              -- V4.3.2: Avoid duplicate versions
  title TEXT,
  citation_count INTEGER DEFAULT 0,
  influential_citation_count INTEGER DEFAULT 0,
  source TEXT,
  last_checked TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(umid, paper_id)
);
```

## 3.2 Models Table Extensions

```sql
ALTER TABLE models ADD COLUMN has_benchmarks BOOLEAN DEFAULT FALSE;
ALTER TABLE models ADD COLUMN params_billions REAL;
ALTER TABLE models ADD COLUMN context_length INTEGER;
ALTER TABLE models ADD COLUMN architecture_family TEXT;
ALTER TABLE models ADD COLUMN base_model_umid TEXT;
ALTER TABLE models ADD COLUMN deploy_score REAL;
```

---

# Part 4: UMID Mapping V4.3.2 (Enhanced)

## 4.1 Multi-Channel Matching Formula

```
match_score =
  0.50 * name_similarity (Jaro-Winkler) +
  0.20 * author_fingerprint_match +
  0.15 * params_similarity (±20%) +
  0.10 * architecture_family_match +
  0.05 * license_match
```

## 4.2 Thresholds (V4.3.2)

| Score Range | Action |
|-------------|--------|
| ≥ 0.88 | ✅ ACCEPT |
| 0.65 – 0.88 | ⚠️ HUMAN REVIEW QUEUE |
| 0.35 – 0.65 | 📝 entity_links with low_confidence flag |
| < 0.35 | ❌ REJECT → Shadow DB |

## 4.3 Benchmark Name Normalization

```javascript
function normalizeBenchName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .replace(/-(instruct|chat|base)$/, '')
    .replace(/-(v\d+)$/, '-$1');
}
```

---

# Part 5: Validation Gates V4.3.2

## 5.1 Benchmark Plausibility Gate (NEW)

```javascript
function validateBenchmark(record) {
  const { mmlu, humaneval, hellaswag, arc_challenge } = record;
  
  // Invalid: scores out of range
  if ([mmlu, humaneval, hellaswag, arc_challenge].some(s => s < 0 || s > 100)) {
    return { quality_flag: 'invalid', reason: 'SCORE_OUT_OF_RANGE' };
  }
  
  // Suspect: all scores suspiciously low
  const sum = (mmlu || 0) + (hellaswag || 0) + (arc_challenge || 0);
  if (sum < 30) {
    return { quality_flag: 'suspect', reason: 'SUM_TOO_LOW' };
  }
  
  return { quality_flag: 'ok' };
}
```

## 5.2 Quality Gates Matrix

| Gate | Test | Pass Criteria |
|------|------|---------------|
| Schema Compliance | AJV | 100% pass |
| UMID Mapping | Integration | ≥ 90% coverage |
| Benchmark Plausibility | Unit | quality_flag = 'ok' |
| SQL Injection | Security | All text sanitized |
| Shadow Rate | Performance | ≤ 1% |

---

# Part 6: Deployability Index V4.3.2 (NEW)

## 6.1 Formula

```javascript
function calculateDeployScore(specs) {
  let score = 0;
  
  // GGUF availability (+0.4)
  if (specs.quantization_formats?.includes('gguf')) score += 0.4;
  
  // Context length (+0.1–0.2)
  score += (specs.context_length > 8192) ? 0.2 : 0.1;
  
  // Model size (+0.1–0.2)
  score += (specs.params_billions < 10) ? 0.2 : 0.1;
  
  // Ollama availability (+0.2)
  if (specs.exists_in_ollama) score += 0.2;
  
  return Math.min(score, 1.0);
}
```

## 6.2 Impact on FNI

```sql
UPDATE models SET fni_u = fni_u + (deploy_score * 0.3)
WHERE umid IN (SELECT umid FROM model_specs WHERE deploy_score > 0);
```

---

# Part 7: L8 Precompute Extensions V4.3.2

## 7.1 New Cache Files

```
ai-nexus-assets/cache/
├── trending_*.json       (existing)
├── leaderboard.json      (existing)
├── categories.json       (existing)
├── specs.json            (V4.3.2 NEW)
├── benchmarks.json       (V4.3.2 NEW)
└── graph/
    └── architecture_families.json  (V4.3.2 NEW)
```

## 7.2 specs.json Structure

```json
{
  "version": "4.3.2",
  "generated_at": "2025-12-11T00:00:00Z",
  "ttl": 3600,
  "data": [
    {
      "umid": "umid_xxx",
      "name": "Model Name",
      "params_billions": 7.0,
      "context_length": 8192,
      "architecture_family": "llama",
      "deploy_score": 0.85
    }
  ]
}
```

---

# Part 8: Monitoring V4.3.2

## 8.1 New Metrics

| Metric | Description |
|--------|-------------|
| bench_coverage | % models with benchmarks |
| specs_coverage | % models with specs |
| deploy_score_avg | Average deployability |
| fni_stability | Day-over-day FNI variance |

## 8.2 FNI Stability Alert (NEW)

```yaml
- name: FNIStabilityAlert
  condition: abs(fni_avg_today - fni_avg_yesterday) > 20%
  action: PagerDuty + Slack
  reason: Prevent ranking collapse from data anomalies
```

---

# Part 9: Phase 2 Execution Roadmap

## Week 0 (Day 0-2): Kickoff

- [ ] Execute migration 0022_schema_v4.3.2.sql
- [ ] Prepare test dataset (200 models)
- [ ] API key acquisition

## Week 1-2: P0 Execution

- [ ] Open LLM Leaderboard Adapter
- [ ] HF Deep Spec Extractor
- [ ] L2/L3 extensions
- [ ] Unit + Integration tests

**Acceptance**: Benchmark coverage ≥ 80%, Specs coverage ≥ 80%

## Week 3-4: P1 Execution

- [ ] PapersWithCode adapter
- [ ] Semantic Scholar adapter
- [ ] model_citations population

**Acceptance**: Citation coverage ≥ 60%

## Week 5: Hardening

- [ ] L8 Precompute with specs.json + benchmarks.json
- [ ] Monitoring dashboards
- [ ] Full validation (1000 models)
- [ ] Rollback SOP documentation

---

# Part 10: Success Metrics V4.3.2

| Metric | Target |
|--------|--------|
| Benchmark Coverage | ≥ 60% |
| Specs Coverage | ≥ 70% |
| UMID Mapping Success | ≥ 95% |
| Shadow Rate | ≤ 1% |
| Synthetic API Cache Hit | ≥ 90% |
| D1 Reads/Day | < 5K |
| FNI Stability | < 20% daily variance |

---

# Part 11: Compliance Notes

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| API Rate Limits | Exponential backoff + Checkpoint |
| Copyright | Official APIs only, no scraping |
| NSFW Content | L2 dual-layer filtering |
| PII Privacy | Aggregate metrics only |
| UMID Migration | umid_version compatibility |

---

# ✅ Constitution V4.3.2 Approval

| Property | Value |
|----------|-------|
| Status | **APPROVED** |
| Approved By | Chief Systems Architect |
| Date | 2025-12-11 |

> **This Constitution is the Project Highest Law for Free2AITools. All system components must comply with V4.3.2 specifications.**

---

*End of Constitution V4.3.2*
