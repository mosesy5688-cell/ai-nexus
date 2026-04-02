/**
 * FNI Configuration
 * V2.0 Canonical (Phase 6)
 */

export const CONFIG = {
    // V2.0 Master Formula Weights (sum to 1.0)
    // FNI = min(99.9, 0.35*S + 0.25*A + 0.15*P + 0.15*R + 0.10*Q)
    WEIGHTS: {
        S: 0.35,   // Semantic (ANN cosine similarity, query-time)
        A: 0.25,   // Authority (mesh gravity)
        P: 0.15,   // Popularity (asymptotic log compressor)
        R: 0.15,   // Recency (exponential decay)
        Q: 0.10    // Quality (completeness + utility)
    },

    // V18.9 Source Parity Coefficients (Ks)
    SOURCE_COEFFICIENTS: {
        hf: 1.0,       // Model Forge (HuggingFace) - Baseline
        gh: 5.0,       // Tool Source (GitHub)
        arxiv: 30.0,   // Knowledge Roots (ArXiv)
        s2: 30.0,      // Knowledge Roots (Semantic Scholar)
        default: 0.2   // Community Market (CivitAI/Others)
    },

    // V18.9 Decay Tiers (lambda values)
    DECAY: {
        FOUNDATIONAL: 0.002,  // Models, Tools, Agents (~346d half-life)
        STRUCTURAL: 0.005,    // Datasets, Collections, Papers (~138d)
        TEMPORAL: 0.025       // Prompts, Spaces (~28d)
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
