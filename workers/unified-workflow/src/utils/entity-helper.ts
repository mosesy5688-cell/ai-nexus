// Helper functions extracted from Monolith (CES V5.1.2)

export interface ValidationResult {
    valid: boolean;
    errors: string[];
    honeypotTriggers: string[];
}

export function cleanModel(model: any): any {
    const id = model.id || model.modelId || '';

    // V13 FIX: Generate correct slug format for R2 cache path
    // Format: source--author--name (matching hydration.ts and entity-cache-reader.js)
    // Example: replicate:meta/llama → replicate--meta--llama
    const source = model.source || id.split(':')[0] || 'huggingface';
    const idWithoutSource = id.replace(/^[a-z]+:/i, '');
    const slug = `${source}--${idWithoutSource.replace(/\//g, '--').replace(/:/g, '--')}`.toLowerCase();

    const cleanText = (text: string | null): string => {
        if (!text) return '';
        return String(text)
            .replace(/<[^>]*>/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 2000);
    };
    // V8.0: Preserve body_content (truncate to 50KB for Queue 64KB limit)
    const MAX_BODY_SIZE = 50000;
    let bodyContent = model.body_content || model.readme || '';
    if (bodyContent.length > MAX_BODY_SIZE) {
        bodyContent = bodyContent.substring(0, MAX_BODY_SIZE) + '\n\n[...Content truncated. View full on source.]';
    }
    // V8.0: Preserve meta_json for Tech Specs
    let metaJson = model.meta_json;
    if (typeof metaJson === 'string') {
        try { metaJson = JSON.parse(metaJson); } catch { metaJson = {}; }
    }
    metaJson = metaJson || {};

    return {
        id: id,
        slug: slug,
        // V13 FIX: Preserve source field from L1 adapters
        source: source,
        name: cleanText(model.title || model.name || model.id || ''),
        author: model.author || '',
        description: cleanText(model.description || ''),
        body_content: bodyContent, // V8.0: Full README/Model Card
        meta_json: metaJson, // V8.0: Technical specs
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
        // V9.0: params_billions for VRAM Calculator (FIX: was missing, causing 0% fill rate)
        params_billions: model.params_billions || metaJson.params_billions || null,
        // V9.0: architecture for Tech Specs display
        architecture: model.architecture || metaJson.architecture || null,
        last_updated: new Date().toISOString()
    };
}

// Re-export entity type helpers from fni-utils.ts for backward compatibility
export { deriveEntityType, stripFNIFromNonModel } from './fni-utils';

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
 * V9.2.3: Batch route invalid models to Shadow DB
 * Reduces API requests from 2×N to 2×ceil(N/batchSize)
 * Art 2.1: Dirty data blocking while staying under API limit
 */
export async function batchRouteToShadowDB(
    db: D1Database,
    invalidModels: Array<{ model: any; validation: ValidationResult }>
): Promise<number> {
    if (invalidModels.length === 0) return 0;

    const BATCH_SIZE = 50;
    let routed = 0;

    for (let i = 0; i < invalidModels.length; i += BATCH_SIZE) {
        const batch = invalidModels.slice(i, i + BATCH_SIZE);

        try {
            // Build batch statements for models_shadow
            const shadowStmts = batch.map(({ model, validation }) =>
                db.prepare(`
                    INSERT OR REPLACE INTO models_shadow
                        (id, raw_data, validation_errors, honeypot_triggers, created_at)
                    VALUES(?, ?, ?, ?, datetime('now'))
                `).bind(
                    model.id || 'unknown',
                    JSON.stringify(model),
                    JSON.stringify(validation.errors),
                    JSON.stringify(validation.honeypotTriggers)
                )
            );

            // Build batch statements for quarantine_log
            const logStmts = batch.map(({ model, validation }) => {
                const reason = validation.honeypotTriggers.length > 0
                    ? `honeypot:${validation.honeypotTriggers.join(',')}`
                    : `schema:${validation.errors.join(',')}`;
                return db.prepare(`
                    INSERT INTO quarantine_log(entity_id, reason, severity, created_at)
                    VALUES(?, ?, ?, datetime('now'))
                `).bind(
                    model.id || 'unknown',
                    reason,
                    validation.honeypotTriggers.length > 0 ? 'high' : 'medium'
                );
            });

            // Execute all statements in one batch (1 API call for all)
            await db.batch([...shadowStmts, ...logStmts]);
            routed += batch.length;
            console.log(`[L2 Shadow] Batch routed ${batch.length} models to Shadow DB`);
        } catch (error) {
            console.error(`[L2 Shadow] Batch error:`, error);
        }
    }

    return routed;
}

// Re-export computeFNI from fni-utils.ts for backward compatibility
export { computeFNI } from './fni-utils';
