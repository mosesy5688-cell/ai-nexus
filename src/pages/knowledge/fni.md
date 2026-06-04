---
layout: ../../layouts/KnowledgeLayout.astro
title: "FNI: Free2AITools Nexus Index"
slug: fni
description: How the Free2AITools Nexus Index (FNI) V2.0 objectively ranks AI entities using five factors — Semantic, Authority, Popularity, Recency, Quality — plus Agent structured tags.
keywords: fni score, free2aitools nexus index, ai ranking, model selection, agent tags, S.A.P.R.Q
showCatalogCount: true
---

# Free2AITools Nexus Index (FNI)

The **FNI** is the ranking algorithm behind Free2AITools. It evaluates the full catalog of AI entities (models, datasets, papers, tools, agents, spaces, prompts) across five weighted factors to produce a single 0-100 score.

**Current version:** V2.0

## The Formula: S.A.P.R.Q

```
FNI = 0.35*S + 0.25*A + 0.15*P + 0.15*R + 0.10*Q
```

| Factor | Weight | What It Measures |
|--------|--------|-----------------|
| **S — Semantic** | 35% | Query-time relevance via vector similarity matching and AI-powered reranking |
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

**V2.0 (2026)** — Renamed to "Free2AITools Nexus Index." Five-factor S.A.P.R.Q formula. Multi-source aggregation across 7+ platforms. Catalog re-evaluated daily. Agent structured tags for `select_model` API. Factor scores included in every API response.

## Source-Parity Weighting (P factor)

The Popularity factor compares raw engagement (downloads, stars, likes, citations) across platforms whose metrics are not directly comparable — an arXiv citation and a HuggingFace download are not the same unit of signal. To put them on one scale, raw popularity is multiplied by a per-source coefficient (`Ks`) before log-compression. These coefficients are an editorial weighting that favors peer-reviewed academic provenance, and they are published here so the weighting is transparent and contestable:

| Source | Coefficient (Ks) | Rationale |
|--------|------------------|-----------|
| arXiv | 30.0 | Knowledge roots — peer-reviewed / academic provenance |
| Semantic Scholar | 30.0 | Knowledge roots — peer-reviewed / academic provenance |
| GitHub | 5.0 | Tool source — engineering adoption signal |
| HuggingFace | 1.0 | Model forge — baseline (engagement is high-volume, low-cost) |
| CivitAI / other | 0.2 | Community market — high-volume, lower verification |

These are the live values in `scripts/factory/lib/fni-score.js` (`SOURCE_COEFFICIENTS`). The coefficient is applied as `raw_popularity × Ks`, then asymptotically log-compressed (base 8) into the 0-100 P factor, so a high coefficient lifts a source's floor without letting any single metric dominate.

## Anti-Gaming

FNI uses multi-dimensional cross-validation to detect manipulation:
- **Anomalous growth**: alerts when 7-day metric growth exceeds 10x the category average
- **Ratio anomalies**: download/star ratios outside reasonable ranges for the entity type
- **Content mismatch**: high popularity but no substantial documentation or code

Flagged entities are reviewed and scores adjusted. Log-scaling on popularity metrics (P factor) inherently dampens artificial inflation.

## For Developers

Every API response includes `fni_version` and per-factor breakdown. The Semantic factor is scored live at query time, so on static detail/select/compare surfaces it is reported as not-measured (`null` + a note) rather than a placeholder value — honest-contract: a constant is not a measurement:

```json
{
  "fni_score": 72.4,
  "fni_factors": {
    "semantic": null,
    "semantic_note": "query-time baseline; scored live at search; not a per-entity value",
    "authority": 85.2,
    "popularity": 67.1,
    "recency": 91.0,
    "quality": 44.3
  }
}
```

The FNI algorithm is open source: [github.com/mosesy5688-cell/ai-nexus](https://github.com/mosesy5688-cell/ai-nexus)

## Related

- [Methodology](/methodology) — Visual breakdown of the FNI formula and fairness pillars
- [Developers](/developers) — API documentation for `select_model` and `compare`
- [LLM Benchmarks](/knowledge/llm-benchmarks) — Traditional evaluation metrics (MMLU, HumanEval)
- [Local Inference](/knowledge/local-inference) — Running models locally with Ollama/llama.cpp
- [VRAM Requirements](/knowledge/vram) — Hardware needed for different model sizes
