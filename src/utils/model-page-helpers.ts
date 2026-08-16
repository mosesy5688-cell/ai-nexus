/**
 * Model Page Helpers - CES Compliant Extraction
 * Extracted from [...slug].astro for Art 5.1 compliance (< 250 lines)
 */
import { honestAuthor } from './honest-render.ts';

/**
 * Clean description by removing YAML frontmatter, HTML tags, etc.
 */
export function cleanDescription(rawDesc: string | null | undefined): string {
    if (!rawDesc) return '';
    return rawDesc
        .replace(/^[\s\n]*---\s*[\s\S]*?---\s*\n*/g, '')
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
    const author = honestAuthor(model.author);
    return {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        "name": modelName,
        "description": cleanDesc.substring(0, 300),
        "applicationCategory": "AI Model",
        "operatingSystem": "Any",
        "author": author ? { "@type": "Organization", "name": author } : undefined,
        // R-1/T2: this used to fall back to the wall clock, asserting "modified
        // today" for every model with no real timestamp. Absent -> omit the property.
        "dateModified": model.last_updated || undefined,
        "image": coverImage,
        "url": `https://free2aitools.com/model/${slug}`
    };
}

/**
 * Generate Schema.org JSON-LD for prompt/template page
 * Uses CreativeWork (prompts are creative text artifacts, not HowTo sequences).
 */
export function generatePromptJsonLd(prompt: any, slug: string) {
    if (!prompt) return null;
    const name = prompt.name || prompt.title || 'AI System Prompt';
    const cleanDesc = cleanDescription(prompt.description);
    const author = honestAuthor(prompt.author);
    return {
        "@context": "https://schema.org",
        "@type": "CreativeWork",
        "additionalType": "SystemPrompt",
        "name": name,
        "description": (prompt.seo_summary?.description || cleanDesc || '').substring(0, 300),
        // R-1/T6 (D-436): "Community" is not an organisation — it was a render-layer
        // default that dressed an empty record as attributed work. No real author
        // -> the property is OMITTED (schema.org author is optional).
        "author": author ? { "@type": "Organization", "name": author } : undefined,
        "dateModified": prompt.last_updated || undefined,
        "url": `https://free2aitools.com/prompt/${slug}`,
        "inLanguage": "en",
        "isAccessibleForFree": true
    };
}

/**
 * Check if model has capability
 */
export function hasCapability(model: any, capId: string): boolean {
    if (!model || !model.entityDefinition?.capabilities) return true;
    return model.entityDefinition.capabilities.includes(capId);
}
