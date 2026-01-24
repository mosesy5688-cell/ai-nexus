/**
 * VRAM Calculator for V15.0
 * Standardized formula: VRAM = (Params * Factor) + KVCache + SystemOverhead
 */

/**
 * Estimate VRAM required for a model
 * @param {number} params - Parameter count in Billions (e.g., 8, 70, 671)
 * @param {string} quant - Quantization level ('fp16', 'q8', 'q4', 'q2')
 * @param {number} contextLen - Context window size (e.g., 8192, 32768)
 * @returns {number} Estimated VRAM in GB
 */
export function estimateVRAM(params, quant = 'q4', contextLen = 8192) {
    if (!params || isNaN(params) || params <= 0) return 0;

    // 1. Definition of Precision Factors (including GGUF/Meta overhead)
    const factors = {
        'fp16': 2.0, // Full Precision
        'bf16': 2.0,
        'q8': 1.1,   // 8-bit
        'q6': 0.9,   // 6-bit
        'q5': 0.82,  // 5-bit (Common GGUF)
        'q4': 0.75,  // 4-bit (Mainstream Standard)
        'q3': 0.6,
        'q2': 0.4
    };

    const normalizedQuant = (quant || 'q4').toLowerCase();
    const factor = factors[normalizedQuant] || factors['q4'];

    // 2. Compute Model Weights VRAM
    const weightUsage = params * factor;

    // 3. Compute KV Cache (Context Overhead)
    // Refined heuristic accounting for GQA (Grouped Query Attention) and scaling.
    const baseKV = params > 30 ? 1.5 : 0.5; // Base for 8192 tokens
    const kvMultiplier = Math.max(1, contextLen / 8192);
    const kvCache = baseKV * kvMultiplier;

    // 4. System Overhead (CUDA kernels, display, overhead)
    const systemOverhead = 0.5;

    const total = weightUsage + kvCache + systemOverhead;

    return parseFloat(total.toFixed(1));
}

/**
 * Get the standardized formula string for display
 * @param {number} factor 
 * @param {number} kv 
 * @returns {string}
 */
export function getVRAMFormulaLabel(factor, kv) {
    return `VRAM ≈ (Params * ${factor}) + ${kv}GB (KV) + 0.5GB (OS)`;
}
