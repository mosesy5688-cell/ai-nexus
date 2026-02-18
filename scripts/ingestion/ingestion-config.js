/**
 * Ingestion Config
 * V19.0 Factory: Expanded Data Density
 * Target: ~500,000+ entities (Deep-Data Enrichment)
 * Limits aligned with factory-harvest.yml V19.0
 */
export const DEFAULT_CONFIG = {
    sources: {
        // V19.0: Expanded limits for data density enrichment

        // Tier 1: HuggingFace Ecosystem (V19: 3x increase)
        huggingface: { enabled: true, options: { limit: 30000 } },
        'huggingface-datasets': { enabled: true, options: { limit: 20000 } },
        'huggingface-papers': { enabled: true, options: { limit: 5000 } },
        'huggingface-spaces': { enabled: true, options: { limit: 3000 } },

        // Tier 2: GitHub & Academic (V19: 2x increase)
        github: { enabled: true, options: { limit: 10000 } },
        arxiv: { enabled: true, options: { limit: 100000, category: 'cs.AI OR cs.LG OR cs.CL OR cs.CV' } },
        semanticscholar: { enabled: true, options: { limit: 5000 } },

        // Tier 3: AI Model Platforms
        ollama: { enabled: true, options: { limit: 1000 } },
        civitai: { enabled: true, options: { limit: 5000 } },
        replicate: { enabled: true, options: { limit: 5000 } },
        kaggle: { enabled: true, options: { limit: 10000 } },

        // Tier 4: Specialized Sources
        openllm: { enabled: true, options: { limit: 1000 } },
        deepspec: { enabled: true, options: { limit: 2000 } },
        mcp: { enabled: true, options: { limit: 500 } },
        agents: { enabled: true, options: { limit: 200 } }

        // DISABLED:
        // - modelscope: Not needed
        // - paperswithcode: Cloudflare protection
        // - langchain: Commented out in L1
    },
    deduplication: {
        enabled: true,
        mergeStats: true
    },
    compliance: {
        blockNSFW: true
    }
};
