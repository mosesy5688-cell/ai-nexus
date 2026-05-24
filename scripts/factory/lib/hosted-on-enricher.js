/**
 * Phase 3: Hosted-On Enricher
 * Loads hosted-on-{provider}.json from local cache (downloaded from R2 by GHA),
 * builds HF-model-ID → provider[] lookup, and enriches entities inline.
 */

import fs from 'fs';
import path from 'path';

const PROVIDERS = ['replicate', 'together', 'hf-inference'];

export function loadHostedOnMap(cacheDir) {
    const map = new Map();
    let totalModels = 0;
    let latestTimestamp = null;

    for (const provider of PROVIDERS) {
        const filePath = path.join(cacheDir, `hosted-on-${provider}.json`);
        if (!fs.existsSync(filePath)) {
            console.log(`[HOSTED-ON] ${provider}: no data file, skipping`);
            continue;
        }
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (data.collected_at && (!latestTimestamp || data.collected_at > latestTimestamp)) {
                latestTimestamp = data.collected_at;
            }
            for (const m of (data.models || [])) {
                // V27.47: index both formats so enrichHostedOn lookup hits regardless
                // of caller candidate shape. Collectors emit `owner/name`; entity id
                // format is `source-type--owner--name` which strips to `owner--name`.
                const keys = expandModelIdKeys(m.id);
                for (const key of keys) {
                    if (!map.has(key)) map.set(key, []);
                    if (!map.get(key).includes(provider)) map.get(key).push(provider);
                }
            }
            totalModels += (data.models || []).length;
            console.log(`[HOSTED-ON] ${provider}: ${data.count || data.models?.length || 0} models loaded`);
        } catch (err) {
            console.warn(`[HOSTED-ON] ${provider}: failed to load — ${err.message}`);
        }
    }

    console.log(`[HOSTED-ON] Map built: ${map.size} unique models from ${totalModels} total entries`);
    return { map, timestamp: latestTimestamp };
}

function normalizeModelId(raw) {
    if (!raw) return null;
    return raw.toLowerCase().trim();
}

// V27.47: Expand a single source id into all forms that downstream consumers
// might use as lookup keys. Collectors emit `owner/name`; entity normalization
// produces `source-type--owner--name` and strips to `owner--name`. By indexing
// all three forms, enrichHostedOn lookup matches regardless of caller shape.
function expandModelIdKeys(raw) {
    const norm = normalizeModelId(raw);
    if (!norm) return [];
    const keys = new Set([norm]);
    if (norm.includes('/')) {
        // owner/name → owner--name (entity-stripped form)
        keys.add(norm.replace('/', '--'));
    }
    if (norm.includes('--')) {
        // owner--name → owner/name (collector form). Only converts first --,
        // since multi-segment names like `meta-llama--Llama-3-8B` should yield
        // `meta-llama/Llama-3-8B`, not `meta/llama--Llama-3-8B`.
        keys.add(norm.replace('--', '/'));
    }
    return [...keys];
}

export function enrichHostedOn(entity, hostedOnMap, timestamp) {
    if (!hostedOnMap || hostedOnMap.size === 0) return;
    const candidates = [
        entity.id, entity.umid, entity.slug,
        entity.author && entity.name ? `${entity.author}/${entity.name}` : null,
    ].filter(Boolean).map(c => c.toLowerCase().trim());

    for (const candidate of candidates) {
        const stripped = stripPrefix(candidate);
        // V27.47: lookup tries multiple shape variants since map indexes both.
        // Either stripped (`--`) or original `/` form should hit.
        const providers = hostedOnMap.get(stripped) || hostedOnMap.get(candidate);
        if (providers) {
            entity.hosted_on = JSON.stringify(providers);
            entity.hosted_on_checked_at = timestamp;
            return;
        }
    }
}

// V27.47: Robust prefix strip — accepts any `<source>-<type>--` prefix
// (was hardcoded to 4 patterns, missed hf-paper-- / hf-dataset-- / gh-tool--
// / civitai-model-- / kaggle-dataset-- etc.).
function stripPrefix(id) {
    return id.replace(/^[a-z]+-[a-z]+--/, '');
}
