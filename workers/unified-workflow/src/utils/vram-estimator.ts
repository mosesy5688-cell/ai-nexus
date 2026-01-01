/**
 * VRAM Estimator - V12 Acceptance Criteria
 * 
 * Formula: VRAM_GB = params_billions * 0.6 + 2
 * - 0.6 accounts for fp16 weights (~2 bytes per param)
 * - +2 accounts for runtime overhead (KV cache, activations)
 * 
 * Extracted from model-enricher.ts for CES compliance (Art 5.1)
 */

export interface VramResult {
    vram_estimated_gb: number | null;
    vram_source: 'params' | 'name_inference' | 'unknown';
}

/**
 * Estimate VRAM requirement using formula: VRAM_GB = params_billions * 0.6 + 2
 * 
 * @param model - Model data with optional params info
 * @returns Estimated VRAM in GB and source
 */
export function estimateVram(model: any): VramResult {
    // 1. Try to get params from config
    const params = model.config?.num_parameters || model.safetensors?.total || model.params_billions;

    if (params && typeof params === 'number') {
        const paramsInBillions = params >= 1e9 ? params / 1e9 : params;
        const vram = Math.round((paramsInBillions * 0.6 + 2) * 10) / 10;
        return {
            vram_estimated_gb: Math.min(vram, 999),
            vram_source: 'params'
        };
    }

    // 2. Try name inference
    const name = (model.name || model.id || '').toLowerCase();

    // MoE detection (8x7b = ~8GB actual inference)
    const moeMatch = name.match(/(\d+)x(\d+)b/);
    if (moeMatch) {
        const perExpert = parseInt(moeMatch[2]);
        const activeParams = 2 * perExpert; // MoE activates ~2 experts
        const vram = Math.round((activeParams * 0.6 + 2) * 10) / 10;
        return { vram_estimated_gb: vram, vram_source: 'name_inference' };
    }

    // Standard size patterns
    const sizePatterns: [RegExp, number][] = [
        [/\b(70|72)b\b/i, 70],
        [/\b(30|32|33|34)b\b/i, 32],
        [/\b(13|14)b\b/i, 13],
        [/\b(7|8)b\b/i, 7],
        [/\b(3|4)b\b/i, 3],
        [/\b(1|1\.5|2)b\b/i, 1.5],
        [/\b\d{2,3}m\b/i, 0.5],
    ];

    for (const [pattern, paramsBillions] of sizePatterns) {
        if (pattern.test(name)) {
            const vram = Math.round((paramsBillions * 0.6 + 2) * 10) / 10;
            return { vram_estimated_gb: vram, vram_source: 'name_inference' };
        }
    }

    return { vram_estimated_gb: null, vram_source: 'unknown' };
}
