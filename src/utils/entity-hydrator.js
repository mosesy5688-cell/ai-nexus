/** Unified Entity Hydrator (V16.5) */
import { beautifyName, beautifyAuthor, extractTechSpecs } from './entity-utils.js';
import { handleModelType, handlePaperType, handleGenericType, mineRelations } from './entity-type-handlers.js';
import { applyVramLogic } from './entity-vram-logic.js';

export function hydrateEntity(data, type, summaryData) {
    if (!data) return null;

    const entity = data.entity || data;
    const computed = data.computed || {};
    const seo = data.seo || {};

    let meta = {};
    try {
        if (entity.meta_json) {
            meta = typeof entity.meta_json === 'string' ? JSON.parse(entity.meta_json) : entity.meta_json;
        }
    } catch (e) {
        console.warn('[Hydrator] meta_json parse error:', e.message);
    }

    const derivedName = entity.name || entity.title || entity.pretty_name || (entity.id ? entity.id.split('--').pop() : 'Unknown');

    const hydrated = {
        ...entity,
        meta: meta,
        meta_json: meta, // V18.2.1 Alignment: Ensure meta_json is an object for downstream components
        fni_score: computed.fni ?? entity.fni_score ?? entity.fni ?? 0,
        fni_percentile: computed.fni_percentile ?? entity.fni_percentile ?? entity.percentile,
        fni_commentary: computed.fni_commentary || entity.fni_commentary || meta.fni?.commentary || null,
        fni_metrics: computed.fni_metrics || entity.fni_metrics || meta.fni?.metrics || {},
        // V16.4.1 FNI Sub-score Promotion
        fni_p: computed.fni_p ?? entity.fni_p ?? entity.fniP ?? meta.fni?.p ?? meta.p ?? 0,
        fni_v: computed.fni_v ?? entity.fni_v ?? entity.fniV ?? meta.fni?.v ?? meta.v ?? 0,
        fni_c: computed.fni_c ?? entity.fni_c ?? entity.fniC ?? meta.fni?.c ?? meta.c ?? 0,
        fni_u: computed.fni_u ?? entity.fni_u ?? entity.fniU ?? meta.fni?.u ?? meta.u ?? 0,
        name: derivedName,
        relations: computed.relations || entity.relations || meta.extended?.relations || meta.relations || {},
        body_content: entity.body_content || meta.html_readme || meta.readme || null,
        _computed: computed,
        _seo: seo,
        _hydrated: true
    };

    beautifyName(hydrated);
    beautifyAuthor(hydrated); // V16.8.31: Identity reconstruction (SPEC-ID-V2.1)
    if (summaryData) attemptWarmCacheFallback(hydrated, summaryData);
    extractTechSpecs(hydrated, entity, meta);
    mineRelations(hydrated, meta);

    // V16.5: Deep Spec Inference from meta
    if (meta.technical) {
        if (!hydrated.params_billions) hydrated.params_billions = meta.technical.parameters_b || meta.technical.size_b;
        if (!hydrated.context_length) hydrated.context_length = meta.technical.context_window || meta.technical.ctx;
        if (!hydrated.architecture) hydrated.architecture = meta.technical.arch || meta.technical.type;
    }

    // Type-specific logic moved to handlers
    if (type === 'model') handleModelType(hydrated, entity, computed, meta, derivedName);
    else if (type === 'paper') handlePaperType(hydrated, entity, meta, derivedName);
    else handleGenericType(hydrated, entity, type, meta, derivedName);

    // Elastic Parameter Inference
    if (!hydrated.params_billions || hydrated.params_billions <= 0) {
        const pVal = entity.params || meta.params || meta.technical?.parameters_b || meta.technical?.size_b || 0;
        if (pVal > 0) {
            hydrated.params_billions = parseFloat(pVal);
        } else {
            const idStr = (hydrated.id || '').toLowerCase();
            const paramMatch = idStr.match(/(\d+)([bm])$/);
            if (paramMatch) {
                const val = parseFloat(paramMatch[1]);
                const unit = paramMatch[2];
                hydrated.params_billions = unit === 'b' ? val : val / 1000;
            }
        }
    }

    if (type === 'model') applyVramLogic(hydrated);
    return hydrated;
}

function attemptWarmCacheFallback(hydrated, summaryData) {
    if (!Array.isArray(summaryData)) return;
    if (hydrated.params_billions && hydrated.downloads) return;

    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const searchId = norm(hydrated.id || '').replace(/^(hf-model|gh-model)--/, '');
    const fallback = summaryData.find(s => {
        const sid = norm(s.id || s.umid || s.slug || '').replace(/^(hf-model|gh-model)--/, '');
        return sid === searchId || sid.endsWith('-' + searchId) || searchId.endsWith('-' + sid) || sid === norm(hydrated.slug);
    });

    if (fallback) {
        hydrated.params_billions = hydrated.params_billions || fallback.params_billions;
        hydrated.downloads = hydrated.downloads || fallback.downloads;
        hydrated.likes = hydrated.likes || fallback.likes || fallback.stars;
        hydrated.context_length = hydrated.context_length || fallback.context_length;
        hydrated.fni_score = hydrated.fni_score || fallback.fni_score || fallback.fni;
    }
}

export function augmentEntity(hydrated, summaryData) {
    if (!hydrated || !summaryData) return hydrated;
    ['params_billions', 'context_length', 'mmlu', 'humaneval', 'hellaswag', 'arc_challenge', 'avg_score', 'fni_score', 'fni_percentile'].forEach(key => {
        if (summaryData[key] !== undefined && !hydrated[key]) hydrated[key] = summaryData[key];
    });
    if (summaryData.architecture_family && !hydrated.architecture) hydrated.architecture = summaryData.architecture_family;
    if (hydrated.params_billions && !hydrated.vram_gb) applyVramLogic(hydrated);
    return hydrated;
}
