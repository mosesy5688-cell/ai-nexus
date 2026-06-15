# Free2AITools — The Open-Source AI Registry

[![smithery badge](https://smithery.ai/badge/mosesy5688/free2aitools)](https://smithery.ai/servers/mosesy5688/free2aitools)

Discover, rank, and compare AI models, datasets, papers, tools, and benchmarks. Updated daily, scored by the Free2AITools Nexus Index (FNI).

**Website**: [free2aitools.com](https://free2aitools.com)

## What It Does

- **Cross-source catalog** — Models, datasets, papers, tools, and benchmarks from HuggingFace, GitHub, ArXiv, Ollama, Replicate, Civitai, and more
- **FNI Ranking** — 5-factor composite score (Semantic, Authority, Popularity, Recency, Quality) with full breakdown in every API response
- **Hardware-Aware Selection** — Find models that fit your VRAM, license, and task constraints
- **Daily Updates** — Automated pipeline refreshes all data daily

## For Developers & AI Agents

### Model Selection API
```bash
curl -s https://free2aitools.com/api/v1/select \
  -H "Content-Type: application/json" \
  -d '{"task":"text-generation","constraints":{"max_vram_gb":8}}'
```
Returns ranked recommendations with params, VRAM estimates, license, and rationale.

### Model Comparison API
```bash
# <ID_1>,<ID_2> are id values taken from /api/v1/search results — substitute your own.
curl "https://free2aitools.com/api/v1/compare?ids=<ID_1>,<ID_2>"
```
Side-by-side comparison with FNI factor decomposition. Obtain ids from the Search API first; see the [Developer Docs](https://free2aitools.com/developers) for a runnable search-first flow.

### Search API
```bash
curl "https://free2aitools.com/api/v1/search?q=code+generation&limit=5"
```

### MCP Server
Add to Claude, Cursor, Windsurf, or any MCP-compatible client:
```json
{
  "mcpServers": {
    "free2aitools": {
      "url": "https://free2aitools.com/api/mcp"
    }
  }
}
```
5 tools: `free2aitools_search`, `free2aitools_rank`, `free2aitools_explain`, `free2aitools_select_model`, `free2aitools_compare`.

### FNI Badge
Embed a live FNI score in your README. Replace `<YOUR_UMID>` with the `id` of
your entity from a Search API response (this is a template, not a live badge):
```markdown
![FNI Score](https://free2aitools.com/api/v1/badge/<YOUR_UMID>)
```

### Open Data
Parquet exports available for offline analysis with DuckDB, Pandas, or Spark.

## Documentation

- [Developer Docs](https://free2aitools.com/developers) — API reference, MCP setup, Badge integration
- [FNI Methodology](https://free2aitools.com/methodology) — Scoring formula, sub-factors, anti-manipulation
- [Trends](https://free2aitools.com/trends) — Weekly AI model intelligence

No auth required. Free to use.

## License

MIT
