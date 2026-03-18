// src/scripts/lib/DataNormalizer.js
/**
 * Shared data normalization logic for V16.2 Search & Catalog
 * Ensures consistent fields across different data sources (core vs full json)
 */
import { stripPrefix } from '../../utils/mesh-routing-core.js';

export const DataNormalizer = {
    normalize(item, defaultType = 'model') {
        if (!item) return null;
        const id = item.id;
        const type = item.type || defaultType;
        let name = item.name || '';

        // V16.8.15 R5.7.2: Treat "Unknown" as empty to trigger derivation fallback
        if (name.toLowerCase() === 'unknown') name = '';

        let slug = item.slug || '';
        let author = item.author || '';

        // Derive missing name from ID
        if (!name && id && typeof id === 'string') {
            name = id.split('--').pop().split(':').pop().split('/').pop();
        } else if (!name) {
            name = 'Untitled Entity';
        }

        // V16.9.23: ALWAYS normalize the slug to ensure author/name format
        if (id) {
            slug = stripPrefix(id).replace(/--/g, '/');
        }

        // Derive missing author from ID
        if (!author && id) {
            if (id.includes('--')) {
                author = id.split('--')[1];
            } else if (id.includes(':')) {
                author = id.split(':')[1].split('/')[0];
            }
        }

        // V23.4: Industrial Spec Technical Extraction
        let license = item.license || '';
        let raw_tag = item.pipeline_tag || '';
        let pipeline_tag = raw_tag.split(/\s+/)[0].replace(/[:/]/g, '').toLowerCase(); // Strict Opus 4.6 Cleaning

        let params_billions = parseFloat(item.params_billions ?? item.params ?? item.technical?.parameters_b ?? 0);
        // V24.12: Auto-convert raw param count to billions (e.g., 3821079552 â†?3.8)
        if (params_billions > 1000) params_billions = params_billions / 1e9;
        params_billions = Math.round(params_billions * 100) / 100;
        // V23.1:        // FNI Indexing - V25.1.2: Radical Calibration fallback
        let fni = item.fni_score ?? item.fni ?? 0;
        if (fni === 0 && item.quality_score) fni = item.quality_score;
        const normalizedFni = Math.round(fni);
        let fni_score = Math.round(normalizedFni * 1000) / 1000;
        let context_length = parseInt(item.context_length ?? item.context ?? 0);
        let vram_est = item.vram_estimate_gb ?? item.vram_est ?? item.vram ?? 0;
        // V24.12: Auto-convert raw bytes to GB (e.g., 2865809667 â†?~2.7)
        if (vram_est > 10000) vram_est = Math.round(vram_est / 1e9 * 10) / 10;

        // V23.1 Shard-DB 4.0: Extract from tags (models.json / legacy shards)
        if (item.tags && Array.isArray(item.tags)) {
            if (!license) {
                const licTag = item.tags.find(t => t.startsWith('license:'));
                if (licTag) license = licTag.split(':')[1].trim();
            }
            if (!pipeline_tag) {
                const bestTag = item.tags.find(t => !/[:/\s]/.test(t) && t.length > 2 && t.length < 15);
                if (bestTag) pipeline_tag = bestTag.toLowerCase();
            }
        }

        // V23.1 Shard-DB 4.0: Deep YAML Extraction from Summary
        if (item.summary && item.summary.startsWith('---')) {
            const yamlPart = item.summary.split('---')[1];
            if (yamlPart) {
                if (!license) {
                    const licMatch = yamlPart.match(/license:\s*([^\n\r]+)/i);
                    if (licMatch) license = licMatch[1].trim();
                }
                if (!pipeline_tag) {
                    const tagMatch = yamlPart.match(/pipeline_tag:\s*([^\n\r]+)/i) || yamlPart.match(/task:\s*([^\n\r]+)/i);
                    if (tagMatch) pipeline_tag = tagMatch[1].trim().split(/\s+/)[0].toLowerCase();
                }
                if (params_billions === 0) {
                    const pMatch = yamlPart.match(/params:\s*([0-9.]+)/i) || yamlPart.match(/parameters:\s*([0-9.]+)/i) || yamlPart.match(/size:\s*([0-9.]+)/i);
                    if (pMatch) params_billions = parseFloat(pMatch[1]);
                }
                if (context_length === 0) {
                    const ctxMatch = yamlPart.match(/context:\s*([0-9.]+)/i) || yamlPart.match(/context_length:\s*([0-9.]+)/i) || yamlPart.match(/ctx:\s*([0-9.]+)/i);
                    if (ctxMatch) context_length = parseInt(ctxMatch[1]);
                }
                // Check for embedded FNI in YAML (some experimental shards)
                const fniMatch = yamlPart.match(/fni_score:\s*([0-9.]+)/i);
                if (fniMatch && fni_score === 0) fni_score = parseFloat(fniMatch[1]);
            }
        }

        // V23.4: Virtual VRAM Estimator (Params * 2 + overhead)
        if (params_billions > 0 && !vram_est) {
            vram_est = Math.ceil(params_billions * 2 * 1.2); // Rough 16-bit estimate + KV overhead
        }

        const normalized = {
            ...item,
            id,
            name,
            type,
            slug,
            author,
            license,
            architecture: item.architecture || '',
            pipeline_tag: pipeline_tag || type,
            category: item.category || item.primary_category || '',
            fni_score,
            fni_percentile: item.fni_percentile || item.percentile || '',
            fni_p: item.fni_p ?? item.fniP ?? item.fni_metrics?.p ?? 0,
            fni_f: item.fni_f ?? item.fni_metrics?.f ?? 0,
            fni_v: item.fni_v ?? item.fniV ?? item.fni_metrics?.v ?? 0,
            fni_c: item.fni_c ?? item.fniC ?? item.fni_metrics?.c ?? 0,
            fni_u: item.fni_u ?? item.fniU ?? item.fni_metrics?.u ?? 0,
            params_billions: params_billions || parseFloat(item.params || 0),
            context_length,
            vram_est,
            typeLabel: (pipeline_tag || type).replace(/-/g, ' '),
            downloads: item.downloads ?? item.pulls ?? item.installs ?? item.download_count ?? 0,
            summary: item.summary || ''
        };

        if (id && normalized.fni_score > 0) {
            console.debug(`[NORM] ${id}: FNI=${normalized.fni_score}, B=${normalized.params_billions}, VRAM=${normalized.vram_est}`);
        }

        return normalized;
    },

    /**
     * Normalizes a collection of items
     */
    normalizeCollection(items, defaultType = 'model') {
        if (!Array.isArray(items)) return [];
        return items.map(item => this.normalize(item, defaultType)).filter(Boolean);
    },

    /**
     * Sorts a collection based on a specified criteria
     */
    sortCollection(items, sortBy) {
        switch (sortBy) {
            case 'fni':
                items.sort((a, b) => (b.fni_score || 0) - (a.fni_score || 0));
                break;
            case 'downloads':
                items.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
                break;
            case 'likes':
                items.sort((a, b) => (b.likes || 0) - (a.likes || 0));
                break;
            case 'recent':
                items.sort((a, b) => new Date(b.lastModified || 0) - new Date(a.lastModified || 0));
                break;
            case 'name':
                items.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
                break;
        }
        return items;
    }
};
