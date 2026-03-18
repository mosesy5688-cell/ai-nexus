/**
 * VRAM Calculator for V15.0
 * Standardized formula: VRAM = (Params * Factor) + KVCache + SystemOverhead
 */

/**
 * Estimate VRAM required for a model
 * @param {number} params - Parameter count in Billions (e.g., 8, 70, 671)
 * @param {string} quant - Quantization level ('fp16', 'q8', 'q4', 'q2')
 * @param {number} contextLen - Context window size (e.g., 8192, 32768)
 * @param {object} moeSpecs - Optional Mixtral/MoE specs { experts, active }
 * @returns {number} Estimated VRAM in GB
 */
export function estimateVRAM(params, quant = 'q4', contextLen = 8192, moeSpecs = null) {
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
    // For MoE, we still load Total Parameters to avoid high-latency expert swapping
    const weightUsage = params * factor;

    // 3. Compute KV Cache (Context Overhead)
    // Heuristic based on industry standards for Llama-style architectures
    let kvCache = 0;
    if (contextLen <= 8192) {
        kvCache = params > 30 ? 2.0 : 0.8;
    } else if (contextLen <= 32768) {
        kvCache = params > 30 ? 5.0 : 2.0;
    } else {
        // Ultra-long context (128k+)
        kvCache = params > 30 ? 12.0 : 4.0;
    }

    // MoE Adjustment: If MoE is specified, we add a minor padding for router/expert management overhead
    const moeOverhead = moeSpecs?.experts ? 0.2 : 0;

    // 4. System Overhead (CUDA kernels, display, overhead)
    const systemOverhead = 0.5;

    const total = weightUsage + kvCache + systemOverhead + moeOverhead;

    return parseFloat(total.toFixed(1));
}

/**
 * Get the standardized formula string for display
 * @param {number} factor 
 * @param {number} kv 
 * @param {boolean} isMoe
 * @returns {string}
 */
export function getVRAMFormulaLabel(factor, kv, isMoe = false) {
    return `VRAM ≈ (Params * ${factor})${isMoe ? ' (MoE Total)' : ''} + ${kv}GB (KV) + 0.5GB (OS)`;
}
