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
                const id = normalizeModelId(m.id);
                if (!id) continue;
                if (!map.has(id)) map.set(id, []);
                if (!map.get(id).includes(provider)) map.get(id).push(provider);
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

export function enrichHostedOn(entity, hostedOnMap, timestamp) {
    if (!hostedOnMap || hostedOnMap.size === 0) return;
    const candidates = [
        entity.id, entity.umid, entity.slug,
        entity.author && entity.name ? `${entity.author}/${entity.name}` : null,
    ].filter(Boolean).map(c => c.toLowerCase().trim());

    for (const candidate of candidates) {
        const stripped = stripPrefix(candidate);
        const providers = hostedOnMap.get(stripped) || hostedOnMap.get(candidate);
        if (providers) {
            entity.hosted_on = JSON.stringify(providers);
            entity.hosted_on_checked_at = timestamp;
            return;
        }
    }
}

function stripPrefix(id) {
    return id.replace(/^(hf-model--|hf-agent--|replicate-model--|ollama-model--)/, '');
}
