/**
 * Ingestion Config
 * V14.4 Factory: Full L1 scale
 * Target: ~100,000 entities (matching original L1)
 * Source: loop1-harvester-v42.yml exact limits
 */
export const DEFAULT_CONFIG = {
    sources: {
        // V14.4 Factory: EXACT L1 limits from loop1-harvester-v42.yml

        // Tier 1: HuggingFace Ecosystem
        huggingface: { enabled: true, options: { limit: 10000 } },           // L1:46
        'huggingface-datasets': { enabled: true, options: { limit: 10000 } }, // L1:110
        'huggingface-papers': { enabled: true, options: { limit: 3000 } },    // L1:103
        'huggingface-spaces': { enabled: true, options: { limit: 2000 } },    // L1:206

        // Tier 2: GitHub & Academic
        github: { enabled: true, options: { limit: 5000 } },                  // L1:72
        arxiv: { enabled: true, options: { limit: 50000, category: 'cs.AI OR cs.LG OR cs.CL OR cs.CV' } }, // L1:96
        semanticscholar: { enabled: true, options: { limit: 3000 } },         // L1:178

        // Tier 3: AI Model Platforms
        ollama: { enabled: true, options: { limit: 1000 } },                  // L1:142
        civitai: { enabled: true, options: { limit: 5000 } },                 // L1:173
        replicate: { enabled: true, options: { limit: 5000 } },               // L1:154
        kaggle: { enabled: true, options: { limit: 10000 } },                 // L1:162

        // Tier 4: Specialized Sources
        openllm: { enabled: true, options: { limit: 1000 } },                 // L1:188
        deepspec: { enabled: true, options: { limit: 2000 } },                // L1:198
        mcp: { enabled: true, options: { limit: 500 } },                      // L1:147
        agents: { enabled: true, options: { limit: 200 } }                    // L1:214

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
