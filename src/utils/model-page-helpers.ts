/**
 * Model Page Helpers - CES Compliant Extraction
 * Extracted from [...slug].astro for Art 5.1 compliance (< 250 lines)
 */

/**
 * Clean description by removing YAML frontmatter, HTML tags, etc.
 */
export function cleanDescription(rawDesc: string | null | undefined): string {
    if (!rawDesc) return '';
    return rawDesc
        .replace(/^---[\s\S]*?---\s*/m, '')
        .replace(/^---\s*\n?[\s\S]*$/m, '')
        .replace(/\blibrary_name:\s*\w+/gi, '')
        .replace(/\blicense:\s*[^\s]+/gi, '')
        .replace(/\bpipeline_tag:\s*\w+/gi, '')
        .replace(/\bbase_model\b[^.]*\.?/gi, '')
        .replace(/<[^>]*>?/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Generate Schema.org JSON-LD for model page
 */
export function generateModelJsonLd(model: any, slug: string, coverImage: string) {
    if (!model) return null;
    const modelName = model.name || model.canonical_name || 'Unknown Model';
    const cleanDesc = cleanDescription(model.description);
    return {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        "name": modelName,
        "description": cleanDesc.substring(0, 300),
        "applicationCategory": "AI Model",
        "operatingSystem": "Any",
        "author": model.author ? { "@type": "Organization", "name": model.author } : undefined,
        "dateModified": model.last_updated || new Date().toISOString(),
        "image": coverImage,
        "url": `https://free2aitools.com/model/${slug}`
    };
}

/**
 * Check if model has capability
 */
export function hasCapability(model: any, capId: string): boolean {
    if (!model || !model.entityDefinition?.capabilities) return true;
    return model.entityDefinition.capabilities.includes(capId);
}
