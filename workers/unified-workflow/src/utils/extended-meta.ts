/**
 * V9.2: Extended Meta Builder
 * Extracted from ingestion.ts for CES compliance
 */

// Whitelist of valid quantization formats
const VALID_QUANT = ['GGUF', 'AWQ', 'GPTQ', 'EXL2'];

/**
 * Extract quantization formats from tags
 * Constitution: Only accept known, deployable formats
 */
export function extractQuantizations(tags: string[] = []): string[] {
    const quants = new Set<string>();
    const lowerTags = tags.map(t => (t || '').toLowerCase());

    if (lowerTags.some(t => t.includes('gguf'))) quants.add('GGUF');
    if (lowerTags.some(t => t.includes('awq'))) quants.add('AWQ');
    if (lowerTags.some(t => t.includes('gptq'))) quants.add('GPTQ');
    if (lowerTags.some(t => t.includes('exl2'))) quants.add('EXL2');

    return Array.from(quants);
}

/**
 * Safely parse numeric values (params, context_length)
 */
export function parseNumber(input: any): number | null {
    if (input === null || input === undefined) return null;
    const num = typeof input === 'number' ? input : parseFloat(input);
    return isNaN(num) ? null : num;
}

/**
 * Build extended meta object with Phase B.8 fields
 * Supports Partial - avoids L8 write failures
 */
export function buildExtendedMeta(model: any): Record<string, any> {
    const extended: Record<string, any> = {};

    // Extract params_billions
    const params = parseNumber(model.params_billions);
    if (params !== null) extended.params_billions = params;

    // Extract context_length
    const context = parseNumber(model.context_length);
    if (context !== null) extended.context_length = context;

    // Extract architecture
    if (model.architecture) extended.architecture = model.architecture;

    // Extract quantizations from tags
    const quants = extractQuantizations(
        Array.isArray(model.tags) ? model.tags :
            (typeof model.tags === 'string' ? JSON.parse(model.tags || '[]') : [])
    );
    if (quants.length > 0) extended.quantizations = quants;

    return extended;
}
