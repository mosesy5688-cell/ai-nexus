
// Helper functions extracted from Monolith (CES V5.1.2)

export interface ValidationResult {
    valid: boolean;
    errors: string[];
    honeypotTriggers: string[];
}

export function cleanModel(model: any): any {
    const id = model.id || model.modelId || '';
    const slug = id.replace(/\//g, '-');

    const cleanText = (text: string | null): string => {
        if (!text) return '';
        return String(text)
            .replace(/<[^>]*>/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 2000);
    };

    // V8.0: Preserve body_content for Model Card display
    // Truncate to 50KB to fit within Queue message size limit (64KB)
    const MAX_BODY_SIZE = 50000;
    let bodyContent = model.body_content || model.readme || '';
    if (bodyContent.length > MAX_BODY_SIZE) {
        bodyContent = bodyContent.substring(0, MAX_BODY_SIZE) + '\n\n[...Content truncated. View full on source.]';
    }

    // V8.0: Preserve meta_json for Technical Specs display
    let metaJson = model.meta_json;
    if (typeof metaJson === 'string') {
        try { metaJson = JSON.parse(metaJson); } catch { metaJson = {}; }
    }
    metaJson = metaJson || {};

    return {
        id: id,
        slug: slug,
        name: cleanText(model.title || model.name || model.id || ''),
        author: model.author || '',
        description: cleanText(model.description || ''),
        // V8.0: Full README/Model Card for detail page
        body_content: bodyContent,
        // V8.0: Technical specs for TechnicalSpecs component
        meta_json: metaJson,
        tags: JSON.stringify(model.tags || (model.pipeline_tag ? [model.pipeline_tag] : [])),
        likes: model.popularity || model.likes || 0,
        downloads: model.downloads || 0,
        // V6.0: Preserve pipeline_tag for category assignment (Constitution Annex A.2.3)
        pipeline_tag: model.pipeline_tag || null,
        // V4.1 Fix: Match orchestrator field names
        cover_image_url: model.raw_image_url || model.cover_image_url || '',
        body_content_url: model.body_content_url || '',
        source_trail: typeof model.source_trail === 'string'
            ? model.source_trail
            : JSON.stringify(model.source_trail || { source: 'huggingface', fetched_at: new Date().toISOString() }),
        license_spdx: model.license_spdx || model.license || '',
        has_ollama: model.has_ollama ? 1 : 0,
        has_gguf: model.has_gguf ? 1 : 0,
        // V8.0: GGUF variants for Tech Specs
        gguf_variants: model.gguf_variants || [],
        // V8.0: Context length if available
        context_length: model.context_length || metaJson.context_length || null,
        last_updated: new Date().toISOString()
    };
}

/**
 * Derive entity type from UMID prefix
 * Art.X-Entity: Frontend must render by entity.definition
 */
export function deriveEntityType(id: string): string {
    if (!id) return 'model';
    if (id.startsWith('hf-dataset--')) return 'dataset';
    if (id.startsWith('hf-space--')) return 'space';
    if (id.startsWith('benchmark--')) return 'benchmark';
    if (id.startsWith('arxiv--')) return 'paper';
    if (id.startsWith('agent--')) return 'agent';
    return 'model';
}

/**
 * V4.9 Art.X-Entity-FNI: Remove FNI fields from non-Model entities
 * FNI only applies to Model entities; non-model: fni_score = null (not 0)
 */
export function stripFNIFromNonModel(entity: any): any {
    const entityType = deriveEntityType(entity.id || entity.umid);
    if (entityType !== 'model') {
        // Delete FNI fields for non-model entities
        delete entity.fni_score;
        delete entity.fni_p;
        delete entity.fni_v;
        delete entity.fni_c;
        delete entity.fni_u;
        delete entity.fni_rank;
        delete entity.fni_trend;
        delete entity.fni_percentile;
    }
    return entity;
}

/**
 * L2 Normalizer: Validate model data per Constitution V4.8
 * - Schema validation
 * - Honeypot detection
 * - Routes invalid data to Shadow DB
 */
export function validateModel(model: any): ValidationResult {
    const errors: string[] = [];
    const honeypotTriggers: string[] = [];

    // Schema validation
    if (!model.id || model.id.length === 0) {
        errors.push('missing_id');
    }
    if (!model.slug || model.slug.length === 0) {
        errors.push('missing_slug');
    }
    if (model.id && model.id.length > 500) {
        errors.push('id_too_long');
    }
    if (model.description && model.description.length > 50000) {
        errors.push('description_too_long');
    }

    // Honeypot detection (poison data patterns)
    const honeypotPatterns = [
        { pattern: /<script/i, name: 'xss_script' },
        { pattern: /javascript:/i, name: 'xss_javascript' },
        { pattern: /onclick\s*=/i, name: 'xss_onclick' },
        { pattern: /eval\s*\(/i, name: 'xss_eval' },
        { pattern: /union\s+select/i, name: 'sql_union' },
        { pattern: /drop\s+table/i, name: 'sql_drop' },
        { pattern: /\x00/, name: 'null_byte' }
    ];

    const fieldsToCheck = [model.name, model.description, model.author];
    for (const field of fieldsToCheck) {
        if (!field) continue;
        for (const { pattern, name } of honeypotPatterns) {
            if (pattern.test(field)) {
                honeypotTriggers.push(name);
            }
        }
    }

    return {
        valid: errors.length === 0 && honeypotTriggers.length === 0,
        errors,
        honeypotTriggers
    };
}

/**
 * Route invalid data to Shadow DB (Art.Shadow)
 * Never auto-merges to main DB
 */
export async function routeToShadowDB(
    db: D1Database,
    model: any,
    validation: ValidationResult
): Promise<void> {
    try {
        // Insert into models_shadow
        await db.prepare(`
            INSERT OR REPLACE INTO models_shadow
                (id, raw_data, validation_errors, honeypot_triggers, created_at)
            VALUES(?, ?, ?, ?, datetime('now'))
        `).bind(
            model.id || 'unknown',
            JSON.stringify(model),
            JSON.stringify(validation.errors),
            JSON.stringify(validation.honeypotTriggers)
        ).run();

        // Log to quarantine_log
        const reason = validation.honeypotTriggers.length > 0
            ? `honeypot:${validation.honeypotTriggers.join(',')} `
            : `schema:${validation.errors.join(',')} `;

        await db.prepare(`
            INSERT INTO quarantine_log(entity_id, reason, severity, created_at)
            VALUES(?, ?, ?, datetime('now'))
                `).bind(
            model.id || 'unknown',
            reason,
            validation.honeypotTriggers.length > 0 ? 'high' : 'medium'
        ).run();

        console.log(`[L2 Shadow] Routed invalid model to Shadow DB: ${model.id} `);
    } catch (error) {
        console.error(`[L2 Shadow] Error routing to Shadow DB: `, error);
    }
}

/**
 * Compute FNI scores using V4.7 canonical weights
 * FNI = P × 30% + V × 30% + C × 20% + U × 20%
 * 
 * @param model - Current model data
 * @param oldData - Optional 7-day old data for velocity calculation
 */
export function computeFNI(
    model: any,
    oldData?: { downloads: number; likes: number }
): { score: number; p: number; v: number; c: number; u: number } {
    // P: Popularity (30%) - based on downloads and likes
    const downloads = model.downloads || 0;
    const likes = model.likes || 0;
    const maxDownloads = 1000000;
    const maxLikes = 500000;
    const p = Math.min(100,
        (Math.min(likes / maxLikes, 1) * 40 + Math.min(downloads / maxDownloads, 1) * 60)
    );

    // V: Velocity (30%) - 7-day growth rate
    let v = 0;
    if (oldData) {
        const downloadGrowth = downloads - (oldData.downloads || 0);
        const likeGrowth = likes - (oldData.likes || 0);
        // Normalize: 100K downloads/week = 100, 10K likes/week = 100
        const downloadVelocity = Math.min(100, (downloadGrowth / 100000) * 100);
        const likeVelocity = Math.min(100, (likeGrowth / 10000) * 100);
        v = Math.max(0, (downloadVelocity * 0.7 + likeVelocity * 0.3));
    }

    // C: Credibility (20%) - documentation, license, source trail
    let c = 0;
    if (model.license_spdx) c += 30;
    if (model.body_content_url) c += 40;
    if (model.source_trail) c += 30;

    // U: Utility (20%) - runtime ecosystem support
    let u = 0;
    if (model.has_ollama) u += 50;
    if (model.has_gguf) u += 50;

    // V4.7 Constitution: P×30% + V×30% + C×20% + U×20%
    const score = (p * 0.30) + (v * 0.30) + (c * 0.20) + (u * 0.20);

    return {
        score: Math.min(100, Math.round(score)),
        p: Math.round(p),
        v: Math.round(v),
        c,
        u
    };
}
