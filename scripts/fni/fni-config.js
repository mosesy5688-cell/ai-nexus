/**
 * FNI Configuration
 * V14.4 Constitution Art 4.1 Compliant
 */

export const CONFIG = {
    // Weight configuration (must sum to 1.0)
    // V14.4 Constitution Art 4.1:
    // FNI = (P × 0.35) + (V × 0.25) + (C × 0.25) + (U × 0.15)
    WEIGHTS: {
        P: 0.35,  // Popularity (V14.4)
        V: 0.25,  // Velocity (V14.4)
        C: 0.25,  // Completeness (V14.4, was Credibility)
        U: 0.15   // Usability (V14.4)
    },


    // Normalization baselines (based on data distribution)
    NORMALIZATION: {
        MAX_LIKES: 500000,
        MAX_DOWNLOADS: 1000000,
        MAX_GITHUB_STARS: 100000,
        MAX_VELOCITY: 150000
    },

    // Big corps for author reputation
    BIG_CORPS: [
        'meta', 'google', 'microsoft', 'openai', 'anthropic',
        'nvidia', 'alibaba', 'huggingface', 'deepmind', 'stability-ai',
        'mistralai', 'cohere', 'baidu', 'tencent'
    ],

    // Utility score bonuses (V3.3 Data Expansion)
    UTILITY: {
        OLLAMA_BONUS: 30,      // Native Ollama support
        GGUF_BONUS: 25,        // GGUF quantization available
        COMPLETE_README: 15,   // Has comprehensive documentation
        DOCKER_BONUS: 10,      // Docker deployment support
        API_BONUS: 10          // Has inference API
    },

    // Anomaly thresholds
    ANOMALY: {
        GROWTH_MULTIPLIER: 10,  // 10x avg = suspicious
        MIN_DOWNLOAD_RATIO: 1,   // downloads/likes ratio
        MAX_DOWNLOAD_RATIO: 500,
        MIN_CONTENT_FOR_HIGH_LIKES: 500  // bytes
    }
};
