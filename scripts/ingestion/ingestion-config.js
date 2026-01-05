/**
 * Ingestion Config
 * V14.4 Factory: Lean initial run
 * Target: ~3000 entities for first successful run
 */
export const DEFAULT_CONFIG = {
    sources: {
        // V14.4 Factory: Core sources only for initial run
        // Priority: Get first successful Factory run, then scale up

        // Tier 1: Core Sources (essential)
        huggingface: { enabled: true, options: { limit: 1000 } },
        'huggingface-datasets': { enabled: true, options: { limit: 500 } },
        github: { enabled: true, options: { limit: 500 } },

        // Tier 2: Academic Sources
        arxiv: { enabled: true, options: { limit: 1000, category: 'cs.AI OR cs.LG OR cs.CL OR cs.CV' } },

        // Tier 3: Optional (enable after first successful run)
        ollama: { enabled: false, options: { limit: 500 } },
        'huggingface-papers': { enabled: false, options: { limit: 500 } },
        openllm: { enabled: false, options: { limit: 500 } },
        civitai: { enabled: false, options: { limit: 500 } },
        semanticscholar: { enabled: false, options: { limit: 500 } }

        // REMOVED (not needed):
        // - modelscope: API issues
        // - paperswithcode: CF protection
        // - deepspec: Low value
        // - mcp: Low volume
    },
    deduplication: {
        enabled: true,
        mergeStats: true
    },
    compliance: {
        blockNSFW: true
    }
};
