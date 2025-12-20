/**
 * Ingestion Config
 * V6.2 Phase 3: Scale Expansion
 * Target: 25,000+ entities
 */
export const DEFAULT_CONFIG = {
    sources: {
        // Tier 1: Core Sources (use multi-strategy for >1K)
        huggingface: { enabled: true, options: { limit: 8000 } },
        'huggingface-datasets': { enabled: true, options: { limit: 2000 } },
        github: { enabled: true, options: { limit: 4000 } },

        // Tier 2: Academic Sources (3s delay required)
        arxiv: { enabled: true, options: { limit: 5000, category: 'cs.AI OR cs.LG OR cs.CL OR cs.CV' } },

        // Tier 3: Ecosystem Sources
        ollama: { enabled: true, options: { limit: 2000 } },

        // V6.2: ModelScope enabled with API token
        modelscope: { enabled: true, options: { limit: 5000 } },

        // PWC disabled (Cloudflare protection) - use ArXiv + SemanticScholar instead
        paperswithcode: { enabled: false, options: { limit: 200 } },

        // V6.2: HuggingFace Papers (alternative to blocked PWC)
        'huggingface-papers': { enabled: true, options: { limit: 1000 } },

        // V4.9.1 Data Expansion
        openllm: { enabled: true, options: { limit: 1000 } }, // Benchmarks
        deepspec: { enabled: true, options: { limit: 5000 } }, // Specs
        civitai: { enabled: true, options: { limit: 2000 } },  // Models (NSFW filtered)
        semanticscholar: { enabled: true, options: { limit: 2000 } }, // Citations

        // V6.2: MCP Registry (AI Agents / MCP Servers)
        mcp: { enabled: true, options: { limit: 500 } }
    },
    deduplication: {
        enabled: true,
        mergeStats: true
    },
    compliance: {
        blockNSFW: true
    }
};
