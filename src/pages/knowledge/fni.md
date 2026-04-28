---
layout: ../../layouts/KnowledgeLayout.astro
title: "FNI: Free2AITools Nexus Index"
slug: fni
description: How the Free2AITools Nexus Index (FNI) V2.0 objectively ranks 464K+ AI entities using five factors — Semantic, Authority, Popularity, Recency, Quality — plus Agent structured tags.
keywords: fni score, free2aitools nexus index, ai ranking, model selection, agent tags, S.A.P.R.Q
---

# Free2AITools Nexus Index (FNI)

The **FNI** is the ranking algorithm behind Free2AITools. It evaluates 464,000+ AI entities (models, datasets, papers, tools, agents, spaces, prompts) across five weighted factors to produce a single 0-100 score.

**Current version:** `fni_v2.0_s50_factory`

## The Formula: S.A.P.R.Q

```
FNI = 0.35*S + 0.25*A + 0.15*P + 0.15*R + 0.10*Q
```

| Factor | Weight | What It Measures |
|--------|--------|-----------------|
| **S — Semantic** | 35% | Query-time relevance via 768-dim embedding similarity and cluster-based reranking |
| **A — Authority** | 25% | Ecosystem gravity: knowledge mesh centrality, cross-entity citations, source credibility |
| **P — Popularity** | 15% | Community adoption: downloads, stars, likes (log-scaled to prevent gaming) |
| **R — Recency** | 15% | Freshness: exponential time decay with type-specific half-lives |
| **Q — Quality** | 10% | Completeness: README depth, metadata richness, runtime compatibility |

## Agent Structured Tags (V2.0)

Beyond the five score factors, FNI V2.0 attaches structured metadata for machine-readable model selection:

| Tag | Type | Meaning |
|-----|------|---------|
| `ollama_compatible` | boolean | Has GGUF quantization files — can be run via `ollama run` |
| `can_run_local` | boolean | Locally runnable: ≤13B parameters + GGUF available |
| `license_type` | string | Classified as `permissive`, `copyleft`, `non-commercial`, or `unknown` |
| `hosted_on` | string[] | Cloud providers offering this model (Replicate, Together, HF Inference) |
| `hosted_on_checked_at` | ISO date | When the hosting data was last verified |

These tags power the [`select_model` API](/developers) — AI agents can filter models by hardware constraints, license type, and deployment target via MCP or HTTP.

## Interpreting FNI Scores

| Range | Label | Meaning |
|-------|-------|---------|
| **80-100** | Elite | Top-tier: strong across all five factors |
| **60-79** | Strong | Well-rounded with clear strengths in 3+ factors |
| **40-59** | Solid | Good in 1-2 areas, average elsewhere |
| **20-39** | Emerging | New or niche — may be rising fast (check R factor) |
| **0-19** | Low Signal | Minimal community footprint or very stale |

## Version History

**V1.0 (2025)** — Originally called "Freshness-Novelty Index." Four-factor P.V.C.U formula (Popularity, Velocity, Context, Uniqueness). Single-source HuggingFace data. No semantic component.

**V2.0 (2026)** — Renamed to "Free2AITools Nexus Index." Five-factor S.A.P.R.Q formula. Multi-source aggregation (HuggingFace, GitHub, Civitai, Replicate, Ollama, Kaggle, arXiv). Rust FFI pipeline for 464K+ entities. Agent structured tags for `select_model` API. Factor scores exposed in every API response.

## Anti-Gaming

FNI uses multi-dimensional cross-validation to detect manipulation:
- **Anomalous growth**: alerts when 7-day metric growth exceeds 10x the category average
- **Ratio anomalies**: download/star ratios outside reasonable ranges for the entity type
- **Content mismatch**: high popularity but no substantial documentation or code

Flagged entities are reviewed and scores adjusted. Log-scaling on popularity metrics (P factor) inherently dampens artificial inflation.

## For Developers

Every API response includes `fni_version` and per-factor breakdown:

```json
{
  "fni_score": 72.4,
  "fni_factors": {
    "semantic": 50.0,
    "authority": 85.2,
    "popularity": 67.1,
    "recency": 91.0,
    "quality": 44.3
  }
}
```

The FNI algorithm is open source: [`scripts/factory/lib/fni-score.js`](https://github.com/mosesy5688-cell/ai-nexus/blob/main/scripts/factory/lib/fni-score.js)

## Related

- [Methodology](/methodology) — Visual breakdown of the FNI formula and fairness pillars
- [Developers](/developers) — API documentation for `select_model` and `compare`
- [LLM Benchmarks](/knowledge/llm-benchmarks) — Traditional evaluation metrics (MMLU, HumanEval)
- [Local Inference](/knowledge/local-inference) — Running models locally with Ollama/llama.cpp
- [VRAM Requirements](/knowledge/vram) — Hardware needed for different model sizes
