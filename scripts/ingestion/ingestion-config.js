/**
 * Ingestion Config
 * V14.4 Factory: Full source coverage
 * Target: All available L1 sources enabled
 */
export const DEFAULT_CONFIG = {
    sources: {
        // V14.4 Factory: All working L1 sources enabled

        // Tier 1: Core Sources (essential)
        huggingface: { enabled: true, options: { limit: 1000 } },
        'huggingface-datasets': { enabled: true, options: { limit: 500 } },
        github: { enabled: true, options: { limit: 500 } },

        // Tier 2: Academic Sources
        arxiv: { enabled: true, options: { limit: 1000, category: 'cs.AI OR cs.LG OR cs.CL OR cs.CV' } },
        'huggingface-papers': { enabled: true, options: { limit: 500 } },
        semanticscholar: { enabled: true, options: { limit: 500 } },

        // Tier 3: Ecosystem Sources
        ollama: { enabled: true, options: { limit: 500 } },
        openllm: { enabled: true, options: { limit: 500 } },
        deepspec: { enabled: true, options: { limit: 500 } },
        civitai: { enabled: true, options: { limit: 500 } },
        mcp: { enabled: true, options: { limit: 200 } }

        // DISABLED (not working):
        // - modelscope: Not needed
        // - paperswithcode: Cloudflare protection blocks access
    },
    deduplication: {
        enabled: true,
        mergeStats: true
    },
    compliance: {
        blockNSFW: true
    }
};
