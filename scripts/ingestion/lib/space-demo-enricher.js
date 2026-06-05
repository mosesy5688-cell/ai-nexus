/**
 * Space->Model demo enricher.
 *
 * #2142 cancelled the `space` entity type: spaces are no longer emitted as
 * standalone entities and the pack-db filter (isCancelledEntity) ages baked
 * spaces out of meta-NN.db on the next re-pack. The panel decision was to
 * MERGE space->model — preserve the demo signal as a MODEL attribute instead
 * of losing it. This module is that follow-up.
 *
 * A harvested space carries a USES->model link (SpacesAdapter normalize:
 * relations[] target_id = hf-model--<author>--<name>, models_used) plus the
 * HF Space URL (source_url), sdk and runtime/running_status. We collect those
 * into a model-id -> demo map during merge, then fold the demo onto the model
 * it USES under meta_json.demo (cold-tier JSON — no new SQL column, survives
 * the Rust fusion projection via the existing meta_json passthrough).
 *
 * Honest-contract: a demo is attached ONLY when a space genuinely USES the
 * model; demo_url is the real HF Space URL or nothing — never fabricated.
 */
import { normalizeId } from '../../utils/id-normalizer.js';

function parseMeta(metaJson) {
    if (!metaJson) return {};
    if (typeof metaJson === 'string') {
        try { return JSON.parse(metaJson) || {}; } catch { return {}; }
    }
    return typeof metaJson === 'object' ? metaJson : {};
}

/**
 * Scan a batch for `space` entities and record their demo, keyed by the
 * lowercased canonical id of each model the space USES. Higher-liked spaces
 * win when several demo the same model (first-non-empty keeps a stable pick).
 */
export function collectSpaceDemos(entities, demoMap) {
    if (!Array.isArray(entities)) return demoMap;
    for (const e of entities) {
        if (!e || (e.type || e.entity_type) !== 'space') continue;
        const meta = parseMeta(e.meta_json);
        const runtime = meta.runtime || {};
        const demo = {
            demo_url: e.source_url || null,
            demo_sdk: meta.sdk || e.sdk || null,
            demo_status: runtime.stage || meta.running_status || meta.runtime_stage || null,
            demo_likes: typeof e.likes === 'number' ? e.likes : 0,
        };
        if (!demo.demo_url) continue; // no URL -> nothing honest to attach

        // Target model ids come from the USES->model relations (already canonical,
        // hf-model--<author>--<name>). models_used carries the raw `owner/name`; canonicalize
        // it via normalizeId so it matches the model entity id when relations are absent.
        const targets = new Set();
        for (const r of (e.relations || [])) {
            const t = r && (r.target_id || r.target);
            if (t && (r.relation_type === 'USES' || r.type === 'USES')) targets.add(String(t).toLowerCase());
        }
        for (const m of (meta.models_used || [])) {
            const canon = m && normalizeId(String(m), 'huggingface', 'model');
            if (canon) targets.add(canon.toLowerCase());
        }

        for (const key of targets) {
            const prev = demoMap.get(key);
            if (!prev || (demo.demo_likes > prev.demo_likes)) demoMap.set(key, demo);
        }
    }
    return demoMap;
}

/**
 * If `entity` is a model with a demo recorded for it, fold the demo onto its
 * meta_json.demo (preserved through fusion + read by the distiller / bundle).
 * No-op for every other entity. Returns true when a demo was attached.
 */
export function attachSpaceDemo(entity, demoMap) {
    if (!entity || demoMap.size === 0) return false;
    if ((entity.type || entity.entity_type) !== 'model') return false;
    const id = String(entity.id || '').toLowerCase();
    const demo = demoMap.get(id);
    if (!demo) return false;

    const meta = parseMeta(entity.meta_json);
    const { demo_likes, ...publicDemo } = demo; // drop the internal tie-breaker
    meta.demo = publicDemo;
    // Preserve the original storage shape: string in -> string out.
    entity.meta_json = typeof entity.meta_json === 'string' ? JSON.stringify(meta) : meta;
    return true;
}
