/**
 * Entity VRAM Logic (V15.22)
 * CES Compliance: Extracted from entity-hydrator.js to honor line limits.
 */
import { estimateVRAM } from './vram-calculator.js';

/**
 * Apply VRAM estimation logic based on parameters
 * V15.19 Unified Adaptive Engine (V15.0 Standard)
 */
export function applyVramLogic(hydrated) {
    if (!hydrated || !hydrated.params_billions) return;

    const params = typeof hydrated.params_billions === 'string'
        ? parseFloat(hydrated.params_billions.replace(/[^0-9.]/g, ''))
        : hydrated.params_billions;

    if (params > 0) {
        const ctx = hydrated.context_length || 8192;
        // Default to Q4 (0.75x) as the site standard for 'Elite' density
        hydrated.vram_gb = estimateVRAM(params, 'q4', ctx);
        hydrated.vram_gb_fp16 = estimateVRAM(params, 'fp16', ctx);
        hydrated.vram_is_estimated = true;

        // Formula hint for UI components
        const isLarge = params > 30;
        const kv = ctx <= 8192 ? (isLarge ? 2.0 : 0.8) : (ctx <= 32768 ? (isLarge ? 5.0 : 2.0) : (isLarge ? 12.0 : 4.0));
        hydrated.vram_formula = `VRAM ≈ (params * 0.75) + ${kv}GB (KV) + 0.5GB (OS)`;
    }
}
