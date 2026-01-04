/**
 * Ingestion Config
 * V6.2 Phase 3: Scale Expansion
 * Target: 25,000+ entities
 */
export const DEFAULT_CONFIG = {
    sources: {
        // V14.4 Factory: Reduced limits to avoid rate limiting (429 errors)
        // Priority: Get first successful run, then scale up

        // Tier 1: Core Sources - REDUCED for initial Factory run
        huggingface: { enabled: true, options: { limit: 1000 } },  // Reduced from 8000
        'huggingface-datasets': { enabled: true, options: { limit: 500 } },  // Reduced from 2000
        github: { enabled: true, options: { limit: 500 } },  // Reduced from 4000

        // Tier 2: Academic Sources - REDUCED
        arxiv: { enabled: true, options: { limit: 1000, category: 'cs.AI OR cs.LG OR cs.CL OR cs.CV' } },

        // Tier 3: Ecosystem Sources - DISABLED for initial run
        ollama: { enabled: false, options: { limit: 500 } },  // Disable for now
        modelscope: { enabled: false, options: { limit: 1000 } },  // Disable for now
        paperswithcode: { enabled: false, options: { limit: 200 } },
        'huggingface-papers': { enabled: false, options: { limit: 500 } },

        // V4.9.1 Data Expansion - DISABLED for initial run
        openllm: { enabled: false, options: { limit: 500 } },
        deepspec: { enabled: false, options: { limit: 1000 } },
        civitai: { enabled: false, options: { limit: 500 } },
        semanticscholar: { enabled: false, options: { limit: 500 } },
        mcp: { enabled: false, options: { limit: 200 } }
    },
    deduplication: {
        enabled: true,
        mergeStats: true
    },
    compliance: {
        blockNSFW: true
    }
};
