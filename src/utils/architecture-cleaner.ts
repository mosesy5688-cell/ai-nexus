/**
 * Architecture Name Cleaner V19.3
 * Standardizes raw backend strings into human-readable labels.
 */
export function cleanArchitecture(arch: any): string {
    const raw = typeof arch === 'string' ? arch : (typeof arch === 'object' && arch?.name ? arch.name : String(arch || 'Transformer'));

    return raw
        .replace(/_?ForCausalLM/gi, '')
        .replace(/_?ForSequenceClassification/gi, '')
        .replace(/_?ForQuestionAnswering/gi, '')
        .replace(/_?ForTokenClassification/gi, '')
        .replace(/_?ForMaskedLM/gi, '')
        .replace(/_?Model\s*$/i, '')
        .replace(/ForSequentialGeneration$/i, '')
        .replace(/ConditionalGeneration$/i, '')
        .replace(/LM$/i, '')
        .replace(/^_+/, '')
        .replace(/_/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2') // CamelCase support
        .trim();
}
