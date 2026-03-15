import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

let isMarkedConfigured = false;
let sanitizeConfig = null;

export function configureDistiller() {
    if (isMarkedConfigured) return;

    // V25.1 Compute Shift-Left: Pre-allocate Markdown Options
    marked.setOptions({ gfm: true, breaks: true });
    sanitizeConfig = {
        allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'h3']),
        allowedAttributes: { ...sanitizeHtml.defaults.allowedAttributes, 'img': ['src', 'alt', 'width', 'height'] }
    };
    isMarkedConfigured = true;
}

export function distillEntity(e, pBillions, entityLookup) {
    // V24.12: Promote meta_json fields to top-level for DB storage
    const meta = typeof e.meta_json === 'string' ? JSON.parse(e.meta_json || '{}') : (e.meta_json || {});
    e.task_categories ??= Array.isArray(meta.task_categories) ? meta.task_categories.join(', ') : (meta.task_categories || '');
    e.num_rows ??= meta.rows_count || 0;
    e.primary_language ??= Array.isArray(meta.language) ? meta.language[0] : (meta.language || '');
    e.forks ??= meta.forks || 0; 
    e.citation_count ??= meta.citation_count || 0;
    e.stars ??= meta.stars || 0;

    // V25.1.2: FNI Pillar Promotion (Strict P-F-C-U Alignment)
    const fMetrics = e.fni_metrics || meta.fni_metrics || meta.fni?.metrics || {};
    e.fni_p ??= e.fni_p ?? fMetrics.p ?? meta.fni?.p ?? 0;
    e.fni_f ??= e.fni_f ?? fMetrics.f ?? meta.fni?.f ?? 0;
    e.fni_c ??= e.fni_c ?? fMetrics.c ?? meta.fni?.c ?? 0;
    e.fni_u ??= e.fni_u ?? fMetrics.u ?? meta.fni?.u ?? 0;
    e.fni_v ??= e.fni_v ?? 0; // Velocity (Growth) reserved for Stage 4/4

    // V18.9: FNI Singularity is sole authority. No quality_score fallback.
    e.fni_score ??= 0;

    // V25.1 Distillation: Goldmine
    e.runtime_hardware = meta.runtime_hardware || meta.hardware || '';
    e.vocab_size = meta.vocab_size || 0;
    e.num_layers = meta.num_hidden_layers || meta.num_layers || 0;
    e.hidden_size = meta.hidden_size || 0;
    e.datasets_used = Array.isArray(meta.datasets) ? meta.datasets.join(', ') : (meta.datasets || '');
    e.quick_start = meta.quick_start || '';

    // V25.1 Distillation: VRAM Calculation
    if (pBillions > 0) {
        e.vram_fp16_gb = Number((pBillions * 2.2).toFixed(1));
        e.vram_int8_gb = Number((pBillions * 1.2).toFixed(1));
        e.vram_int4_gb = Number((pBillions * 0.7).toFixed(1));
    }

    // V25.1 Distillation: AOT HTML Compilation
    const rawReadme = e.readme || e.html_readme || e.body_content || e.content || e.description || '';
    if (rawReadme && !e.readme_html) {
        try {
            const rawHtml = marked.parse(rawReadme);
            e.readme_html = sanitizeHtml(rawHtml, sanitizeConfig);
        } catch (err) { e.readme_html = ''; }
    }

    // V25.1 Distillation: Mesh Pre-joining
    const relations = Array.isArray(e.relations) ? e.relations : (e.mesh_profile?.relations || []);
    e.ui_related_mesh = JSON.stringify(relations.map(rel => {
        const targetId = rel.target || rel.target_id || rel.id;
        const targetEntity = entityLookup.get(targetId);
        return {
            id: targetId,
            type: rel.type || rel.t || 'model',
            name: targetEntity ? targetEntity.name : targetId,
            icon: targetEntity ? targetEntity.icon : '📦'
        };
    }));

    // V25.1 Distillation: Search Vector Normalization
    const category = e.category || '';
    const tags = Array.isArray(e.tags) ? e.tags.join(', ') : (e.tags || '');
    const tagsCombo = `${tags} ${category} ${e.pipeline_tag || ''}`.toLowerCase();
    let searchExpanded = '';
    if (tagsCombo.includes('nlp') || tagsCombo.includes('text') || tagsCombo.includes('llm')) {
        searchExpanded += ' natural language processing text generation llm language model transformers';
    }
    if (tagsCombo.includes('cv') || tagsCombo.includes('vision') || tagsCombo.includes('image')) {
        searchExpanded += ' computer vision image generation sight';
    }
    e.search_vector = searchExpanded;

    return e;
}
