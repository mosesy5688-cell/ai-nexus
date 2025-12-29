/**
 * HuggingFace Spaces Adapter
 * Fetches interactive demos from HuggingFace Spaces API
 * @module ingestion/adapters/spaces-adapter
 */
import { BaseAdapter } from './base-adapter.js';

const HF_API = 'https://huggingface.co/api';
const HF_RAW = 'https://huggingface.co';

export class SpacesAdapter extends BaseAdapter {
    constructor() {
        super('huggingface');
        this.entityTypes = ['space'];
    }

    async fetch(options = {}) {
        const { limit = 500, sort = 'likes', direction = -1, full = true } = options;
        console.log(`📥 [HF Spaces] Fetching top ${limit} spaces...`);

        const response = await fetch(`${HF_API}/spaces?sort=${sort}&direction=${direction}&limit=${limit}`);
        if (!response.ok) throw new Error(`HF Spaces API error: ${response.status}`);

        const spaces = await response.json();
        console.log(`📦 [HF Spaces] Got ${spaces.length} spaces`);
        if (!full) return spaces;

        // Fetch full details with rate limiting
        const fullSpaces = [];
        for (let i = 0; i < spaces.length; i += 10) {
            const batch = spaces.slice(i, i + 10);
            const results = await Promise.all(batch.map(s => this.fetchFullSpace(s.id)));
            fullSpaces.push(...results.filter(Boolean));
            if ((i + 10) % 50 === 0) console.log(`   Progress: ${Math.min(i + 10, spaces.length)}/${spaces.length}`);
            if (i + 10 < spaces.length) await this.delay(100);
        }
        console.log(`✅ [HF Spaces] Fetched ${fullSpaces.length} complete spaces`);
        return fullSpaces;
    }

    async fetchFullSpace(spaceId) {
        try {
            const apiResponse = await fetch(`${HF_API}/spaces/${spaceId}`);
            if (!apiResponse.ok) return null;
            const data = await apiResponse.json();

            let readme = '', modelsUsed = [];
            try {
                const readmeRes = await fetch(`${HF_RAW}/spaces/${spaceId}/raw/main/README.md`);
                if (readmeRes.ok) {
                    readme = await readmeRes.text();
                    if (readme.length > 50000) readme = readme.substring(0, 50000) + '\n[Truncated]';
                    modelsUsed = this.extractModelsFromReadme(readme);
                }
            } catch (e) { /* ignore */ }

            return { ...data, readme, models_used: modelsUsed, _fetchedAt: new Date().toISOString() };
        } catch (e) {
            console.warn(`⚠️ Error fetching space ${spaceId}: ${e.message}`);
            return null;
        }
    }

    extractModelsFromReadme(readme) {
        const models = [];
        const yamlMatch = readme.match(/^---\n([\s\S]*?)\n---/);
        if (!yamlMatch) return models;
        const yaml = yamlMatch[1];

        // Pattern: models: [model1, model2]
        const arrayMatch = yaml.match(/models:\s*\[(.*?)\]/);
        if (arrayMatch) {
            arrayMatch[1].split(',').forEach(s => {
                const m = s.trim().replace(/['"]/g, '');
                if (m) models.push(m);
            });
        }
        // Pattern: models:\n  - model1
        const listMatch = yaml.match(/models:\s*\n((?:\s+-\s+.+\n?)+)/);
        if (listMatch) {
            listMatch[1].split('\n').forEach(line => {
                const m = line.match(/^\s+-\s+(.+)/);
                if (m) models.push(m[1].trim().replace(/['"]/g, ''));
            });
        }
        return models;
    }

    normalize(raw) {
        const [author, name] = this.parseId(raw.id);
        return {
            id: `hf-space--${this.sanitizeName(author)}--${this.sanitizeName(name)}`,
            type: 'space',
            source: 'huggingface',
            source_url: `https://huggingface.co/spaces/${raw.id}`,
            title: raw.cardData?.title || name,
            description: this.extractDescription(raw.readme || raw.cardData?.short_description),
            body_content: raw.readme || '',
            tags: this.normalizeTags(raw.tags),
            pipeline_tag: raw.sdk || null,
            author,
            license_spdx: this.normalizeLicense(raw.cardData?.license),
            meta_json: {
                sdk: raw.sdk, sdk_version: raw.sdkVersion, runtime: raw.runtime,
                models_used: raw.models_used || [], emoji: raw.cardData?.emoji
            },
            created_at: raw.createdAt,
            updated_at: raw.lastModified,
            popularity: raw.likes || 0,
            downloads: 0,
            likes: raw.likes || 0,
            raw_image_url: raw.cardData?.image || `https://huggingface.co/spaces/${raw.id}/resolve/main/thumbnail.png`,
            relations: (raw.models_used || []).map(m => ({
                target_id: `huggingface--${m.replace(/\//g, '--')}`,
                relation_type: 'USES', confidence: 1.0, source: 'config'
            })),
            content_hash: null, compliance_status: null, quality_score: null
        };
    }

    parseId(id) {
        const parts = (id || '').split('/');
        return parts.length >= 2 ? [parts[0], parts.slice(1).join('-')] : ['unknown', id || 'unknown'];
    }

    normalizeTags(tags) {
        if (!Array.isArray(tags)) return [];
        return tags.filter(t => typeof t === 'string').map(t => t.toLowerCase().trim()).filter(t => t.length > 0 && t.length < 50);
    }

    delay(ms) { return new Promise(r => setTimeout(r, ms)); }
}

export default SpacesAdapter;
