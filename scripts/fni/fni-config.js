/**
 * FNI Configuration
 */

export const CONFIG = {
    // Weight configuration (must sum to 1.0)
    // V4.7 Constitution: FNI = 0.3P + 0.3V + 0.2C + 0.2U
    WEIGHTS: {
        P: 0.30,  // Popularity (V4.7)
        V: 0.30,  // Velocity (V4.7)
        C: 0.20,  // Credibility (V4.7)
        U: 0.20   // Utility (V4.7)
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
