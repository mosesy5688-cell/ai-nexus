/**
 * Ingestion Config
 * Sprint 3 Phase 0 Settings
 */
export const DEFAULT_CONFIG = {
    sources: {
        // V4.1 Phase 3: Operation 10K
        // Target: 15,500 raw → ~10,000 after dedup
        huggingface: { enabled: true, options: { limit: 8000 } },
        'huggingface-datasets': { enabled: true, options: { limit: 1500 } },
        github: { enabled: true, options: { limit: 3000 } },

        // Academic Sources (3s delay required)
        arxiv: { enabled: true, options: { limit: 2000, category: 'cs.AI OR cs.LG OR cs.CL OR cs.CV' } },

        // Ollama Registry (NEW for Phase 3)
        ollama: { enabled: true, options: { limit: 1000 } },

        // PWC disabled (Cloudflare protection)
        paperswithcode: { enabled: false, options: { limit: 200 } },

        // V4.9.1 Data Expansion (Manual Enablement)
        openllm: { enabled: true, options: { limit: 1000 } }, // Benchmarks
        deepspec: { enabled: true, options: { limit: 5000 } }, // Specs
        civitai: { enabled: true, options: { limit: 500 } },  // Models (NSFW filtered)
        semanticscholar: { enabled: true, options: { limit: 1000 } } // Citations
    },
    deduplication: {
        enabled: true,
        mergeStats: true
    },
    compliance: {
        blockNSFW: true
    }
};
