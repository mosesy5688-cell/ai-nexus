/**
 * HuggingFace Spaces Adapter
 * Fetches interactive demos from HuggingFace Spaces API
 * @module ingestion/adapters/spaces-adapter
 */
import { BaseAdapter, NSFW_KEYWORDS } from './base-adapter.js';

const HF_API = 'https://huggingface.co/api';
const HF_RAW = 'https://huggingface.co';

export class SpacesAdapter extends BaseAdapter {
    constructor() {
        super('huggingface');
        this.entityTypes = ['space'];
        this.hfToken = process.env.HF_TOKEN || null;
    }

    // V28: send HF_TOKEN when present (was no token plumbing at all). Authenticated
    // requests raise the HF rate limit = fewer 429 storms on the per-space fan-out.
    getHeaders() {
        const headers = { 'Accept': 'application/json', 'User-Agent': 'Free2AITools/1.0' };
        if (this.hfToken) headers['Authorization'] = `Bearer ${this.hfToken}`;
        return headers;
    }

    async fetch(options = {}) {
        const { limit = 500, sort = 'likes', direction = -1, full = true, onBatch } = options;
        console.log(`📥 [HF Spaces] Fetching top ${limit} spaces...`);

        // V22.8: Paginated fetch for full coverage (HF caps single calls at ~1000)
        const pageSize = 1000;
        const spaces = [];
        for (let offset = 0; offset < limit; offset += pageSize) {
            const fetchLimit = Math.min(pageSize, limit - offset);
            const url = `${HF_API}/spaces?sort=${sort}&direction=${direction}&limit=${fetchLimit}&offset=${offset}`;
            const response = await this.fetchWithTimeout(url, { headers: this.getHeaders() });
            if (!response.ok) {
                console.warn(`   ⚠️ HF Spaces API error at offset ${offset}: ${response.status}`);
                break;
            }
            const batch = await response.json();
            if (!batch.length) break;
            spaces.push(...batch);
            console.log(`   📦 Fetched ${spaces.length} space listings (offset: ${offset})...`);
            if (batch.length < fetchLimit) break;
            await this.delay(500);
        }
        console.log(`📦 [HF Spaces] Got ${spaces.length} spaces from paginated list`);

        // V14.5: Reduced batch size and increased delay to prevent rate limit storms
        const fullSpaces = [];
        const BATCH_SIZE = 2; // Reduced from 10 to prevent parallel 429 storms
        const BATCH_DELAY = 1000; // Increased from 100ms

        // V28.x: aggregate guard. Each fetchFullSpace is per-call bounded
        // (fetchWithTimeout), but this loop had NO aggregate cap — with limit up
        // to 5000 and a 1s delay per 2-space batch (~42min of delay alone at
        // 5000), plus per-space 429 backoff, a slow/throttled HF blows the
        // 60-min harvest step timeout (same class as the LangChain stall:
        // per-item bound != aggregate bound). Bound the loop by wall-clock AND
        // trip a breaker on sustained failure, returning PARTIAL results
        // (best-effort per cron cycle; streamed via onBatch as we go).
        const ENRICH_BUDGET_MS = 40 * 60 * 1000; // hard ceiling, under the 60-min step cap
        const MAX_CONSECUTIVE_FAIL_BATCHES = 25;
        const enrichStart = Date.now();
        let consecutiveFailBatches = 0;
        for (let i = 0; i < spaces.length; i += BATCH_SIZE) {
            if (Date.now() - enrichStart > ENRICH_BUDGET_MS) {
                console.warn(`   ⏱️ [HF Spaces] enrich budget (${ENRICH_BUDGET_MS / 60000}min) reached at ${i}/${spaces.length}; returning partial.`);
                break;
            }
            const batch = spaces.slice(i, i + BATCH_SIZE);

            // V22.7: Pre-fetch NSFW Check
            const safeBatch = batch.filter(s => this.isSafeForWork(s));
            if (safeBatch.length === 0) continue;

            const results = await Promise.all(safeBatch.map(s => this.fetchFullSpace(s.id)));
            const validResults = results.filter(Boolean);

            // Circuit breaker: sustained all-fail batches (HF down/blocking) -> stop, return partial.
            if (validResults.length === 0) {
                if (++consecutiveFailBatches >= MAX_CONSECUTIVE_FAIL_BATCHES) {
                    console.warn(`   🔌 [HF Spaces] ${consecutiveFailBatches} consecutive failed batches; circuit-breaking at ${i}/${spaces.length}.`);
                    break;
                }
            } else { consecutiveFailBatches = 0; }

            if (onBatch) {
                await onBatch(validResults);
            } else {
                fullSpaces.push(...validResults);
            }

            if ((i + BATCH_SIZE) % 50 === 0) console.log(`   Progress: ${Math.min(i + BATCH_SIZE, spaces.length)}/${spaces.length}`);
            if (i + BATCH_SIZE < spaces.length) await this.delay(BATCH_DELAY);
        }
        console.log(`✅ [HF Spaces] ${onBatch ? 'Streaming' : 'Fetched ' + fullSpaces.length + ' complete spaces'} complete`);
        return onBatch ? [] : fullSpaces;
    }

    // V14.5: Added 429 retry logic with exponential backoff
    async fetchFullSpace(spaceId, retryCount = 0) {
        const MAX_RETRIES = 3;

        try {
            const apiResponse = await this.fetchWithTimeout(`${HF_API}/spaces/${spaceId}`, { headers: this.getHeaders() });

            // V14.5: Handle rate limiting with exponential backoff
            if (apiResponse.status === 429) {
                if (retryCount < MAX_RETRIES) {
                    const backoff = Math.min(2000 * Math.pow(2, retryCount), 30000);
                    console.log(`   ⚠️ Rate limited (429) for ${spaceId}, retry ${retryCount + 1}/${MAX_RETRIES} after ${backoff}ms...`);
                    await this.delay(backoff);
                    return this.fetchFullSpace(spaceId, retryCount + 1);
                }
                console.warn(`   ❌ Max retries exceeded for ${spaceId}`);
                return null;
            }

            if (!apiResponse.ok) return null;
            const data = await apiResponse.json();

            let readme = '', modelsUsed = [];
            try {
                const readmeRes = await this.fetchWithTimeout(`${HF_RAW}/spaces/${spaceId}/raw/main/README.md`, { headers: this.getHeaders() });
                if (readmeRes.ok) {
                    readme = await readmeRes.text();
                    if (readme.length > 250000) readme = readme.substring(0, 250000) + '\n[Truncated for memory safety]';
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
        const id = this.generateId(author, name, 'space');
        return {
            id,
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
            raw_image_url: raw.cardData?.image || `https://cdn-thumbnails.huggingface.co/social-thumbnails/spaces/${raw.id}.png`,
            relations: (raw.models_used || []).map(m => {
                const [mAuthor, mName] = this.parseId(m);
                return {
                    target_id: this.generateId(mAuthor, mName, 'model'),
                    relation_type: 'USES', confidence: 1.0, source: 'config'
                };
            }),
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
