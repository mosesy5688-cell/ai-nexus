export const article = {
  title: 'What is FNI?',
  description: 'Free2AITools Nexus Index (FNI) is our transparent, multi-dimensional scoring system for ranking AI entities on Free2AITools.',
  category: 'Metrics',
  content: `
  ## Overview

  **FNI (Free2AITools Nexus Index)** is Free2AITools' open-source scoring system for ranking AI entities (models, datasets, papers, tools, agents, spaces, prompts). It gives a transparent, multi-dimensional view of an entity's standing in the AI ecosystem as a single 0-100 score.

  **Current version:** V2.0 — see the full [FNI methodology page](/knowledge/fni) for the authoritative formula, factor definitions, source weighting, and version history. This page is a short overview; the methodology page is the single source of truth.

  ## The Formula: S.A.P.R.Q

  \`\`\`
  FNI = min(99.9, 0.35*S + 0.25*A + 0.15*P + 0.15*R + 0.10*Q)
  \`\`\`

  ### S - Semantic (35%)
  - Query-time relevance via vector similarity and AI-powered reranking
  - Note: scored live at search time, not stored per-entity; on static surfaces it is reported as not-measured (null)

  ### A - Authority (25%)
  - Knowledge-mesh centrality and cross-entity citations
  - Source credibility

  ### P - Popularity (15%)
  - Downloads, stars, likes (log-scaled to prevent gaming)

  ### R - Recency (15%)
  - Freshness via exponential time decay with type-specific half-lives

  ### Q - Quality (10%)
  - README depth, metadata richness, runtime compatibility

  ## Score Range

  | FNI Score | Label | Interpretation |
  |-----------|-------|----------------|
  | 80-100 | Elite | Strong across all five factors |
  | 60-79 | Strong | Well-rounded, clear strengths in 3+ factors |
  | 40-59 | Solid | Good in 1-2 areas, average elsewhere |
  | 20-39 | Emerging | New or niche — may be rising fast (check R) |
  | 0-19 | Low Signal | Minimal community footprint or very stale |

  ## Why FNI?

  - **Transparent**: All factors and source weighting are published and open source
  - **Multi-dimensional**: Not just downloads
  - **Updated daily**: Catalog re-evaluated each pipeline run
  - **Fair**: Considers smaller and newer entities too

  ## How to Improve FNI

  1. Publish quality benchmarks and documentation
  2. Provide GGUF/Ollama support where applicable
  3. Keep the entity fresh and well-maintained
  4. Engage the community

  See the [full methodology](/knowledge/fni) for the source-parity weighting table and anti-gaming details.
      `
};
