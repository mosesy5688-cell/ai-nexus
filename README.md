# Free2AITools — The Open-Source AI Registry

Discover, rank, and integrate 460,000+ AI models, datasets, papers, and tools from across the open-source ecosystem. Updated daily, scored by the Free2AITools Nexus Index (FNI).

**Website**: [free2aitools.com](https://free2aitools.com)

## What It Does

- **Comprehensive AI Index** — Aggregates models, datasets, papers, agents, tools, spaces, and prompts from HuggingFace, GitHub, ArXiv, Semantic Scholar, Civitai, Replicate, and more
- **FNI Ranking** — Every entity scored by a 5-factor index (Semantic, Authority, Popularity, Recency, Quality) for objective, explainable ranking
- **Daily Reports** — AI-generated industry briefings highlighting trends and breakthroughs
- **Knowledge Base** — 30+ articles on AI architectures, deployment guides, and benchmarks

## For Developers & AI Agents

Free2AITools exposes its full index as infrastructure for AI agents and developer tools:

### REST API
```
GET /api/v1/search?q=text+generation&type=model&limit=5
```
Free, no auth required. Returns FNI-scored results with factor breakdown.

### MCP Server
```json
// Claude Desktop / Cursor / Windsurf config
{
  "mcpServers": {
    "free2ai": {
      "url": "https://free2aitools.com/api/mcp"
    }
  }
}
```
3 tools: `free2ai_search`, `free2ai_rank`, `free2ai_explain`. Auto-discoverable via `/.well-known/mcp.json`.

### FNI Badge
Embed in any README:
```markdown
![FNI Score](https://free2aitools.com/api/v1/badge/meta-llama--llama-3.3-70b-instruct)
```

### Open Data
Parquet exports available for offline analysis with DuckDB, Pandas, or Spark.

## Documentation

- [Developer Docs](https://free2aitools.com/developers) — API reference, MCP setup, Badge integration
- [FNI Methodology](https://free2aitools.com/methodology) — Scoring formula, sub-factors, anti-manipulation
- [Knowledge Base](https://free2aitools.com/knowledge) — AI concepts and deployment guides

## License

MIT
