/**
 * HuggingFace Datasets Adapter
 * Fetches datasets from HuggingFace Hub API with complete data.
 * V25.9: expand[]=siblings eliminates per-dataset API detail requests.
 * @module ingestion/adapters/datasets-adapter
 */

import { BaseAdapter, NSFW_KEYWORDS, FetchError } from './base-adapter.js';
import { extractSchemaInfo, extractDatasetAssets, buildDatasetMetaJson, parseDatasetId, normalizeDatasetTags } from './datasets-helpers.js';
import { normalizeId } from '../../utils/id-normalizer.js';
import { COMPLETE_FOR_C4_STAGE2_CANDIDATE_UNIVERSE } from '../../factory/lib/c4s2-candidate-universe.js';

const HF_API_BASE = 'https://huggingface.co/api';
const HF_RAW_BASE = 'https://huggingface.co';

// C4 Stage-2 (D-335/336): RFC-5988 Link rel="next" cursor extractor (pure).
function parseC4S2NextLink(link) {
  if (!link) return null;
  const seg = String(link).split(',').map(s => s.trim()).find(s => /rel="?next"?/.test(s));
  const m = seg && seg.match(/<([^>]+)>/);
  return m ? m[1] : null;
}

export class DatasetsAdapter extends BaseAdapter {
    constructor() {
        super('huggingface');
        this.entityTypes = ['dataset'];
        this.hfToken = process.env.HF_TOKEN || null;
    }

    // V28: actually send HF_TOKEN (it was read but never used). An authenticated
    // request raises the HF rate limit = fewer 429s. Header only added when a token
    // is present, so anonymous runs are unchanged.
    getHeaders() {
        const headers = { 'Accept': 'application/json', 'User-Agent': 'Free2AITools/1.0' };
        if (this.hfToken) headers['Authorization'] = `Bearer ${this.hfToken}`;
        return headers;
    }

    async fetch(options = {}) {
        const { limit = 500, sort = 'downloads', direction = -1, full = true } = options;
        this.terminalMeta = null; // H2c: clear any prior partial-by-design signal
        console.log(`📥 [HF Datasets] Fetching top ${limit} datasets by ${sort}...`);

        const expandParams = [
            'author', 'cardData', 'createdAt', 'downloads',
            'likes', 'lastModified', 'tags', 'siblings'
        ].map(e => `expand[]=${e}`).join('&');

        const pageSize = 1000;
        const datasets = [];
        for (let offset = 0; offset < limit; offset += pageSize) {
            const fetchLimit = Math.min(pageSize, limit - offset);
            const listUrl = `${HF_API_BASE}/datasets?sort=${sort}&direction=${direction}&limit=${fetchLimit}&offset=${offset}&${expandParams}`;
            const response = await this.fetchWithTimeout(listUrl, { headers: this.getHeaders() });
            if (!response.ok) { console.warn(`   ⚠️ HF Datasets API error at offset ${offset}: ${response.status}`); break; }
            const batch = await response.json();
            if (!batch.length) break;
            datasets.push(...batch);
            console.log(`   📦 Fetched ${datasets.length} dataset listings (offset: ${offset})...`);
            if (batch.length < fetchLimit) break;
            await this.delay(500);
        }
        console.log(`📦 [HF Datasets] Got ${datasets.length} datasets from paginated list`);

        if (!full) return datasets;

        console.log(`🔄 [HF Datasets] Fetching full details...`);
        const fullDatasets = [];
        const baseBatch = this.hfToken ? 3 : 2;
        const baseDelay = this.hfToken ? 800 : 1500;
        let curBatch = baseBatch, curDelay = baseDelay, cleanRuns = 0;
        this._batchHit429 = false;

        // V28.x: aggregate guard. Per-call timeouts + adaptive throttle bound
        // each batch, but the loop had NO aggregate wall-clock cap — with limit
        // up to 10000 and the throttle GROWING curDelay (up to 15s) on 429, a
        // slow/throttled HF drives total time past the 60-min step timeout (same
        // class as the HF Spaces / LangChain stalls: per-item bound != aggregate
        // bound). Bound by wall-clock AND trip a breaker on sustained failure,
        // returning PARTIAL (best-effort per cron cycle; streamed via onBatch).
        const ENRICH_BUDGET_MS = 40 * 60 * 1000; // hard ceiling, under the 60-min step cap
        const MAX_CONSECUTIVE_FAIL_BATCHES = 25;
        const enrichStart = Date.now();
        let consecutiveFailBatches = 0;

        for (let i = 0; i < datasets.length; i += curBatch) {
            if (Date.now() - enrichStart > ENRICH_BUDGET_MS) {
                console.warn(`   ⏱️ [HF Datasets] enrich budget (${ENRICH_BUDGET_MS / 60000}min) reached at ${i}/${datasets.length}; returning partial.`);
                // H2c: minimal partial-by-design signal -> harvest-single maps to partial/enrich_budget.
                this.terminalMeta = { budgetCapped: true, processed: i, total: datasets.length };
                break;
            }
            const batch = datasets.slice(i, i + curBatch);
            const safeBatch = batch.filter(d => this.isSafeForWork(d));
            if (safeBatch.length === 0) { console.log(`   ⏭️ Skipping batch ${i / curBatch} (No safe datasets)`); continue; }

            this._batchHit429 = false;
            const batchResults = await Promise.all(
                safeBatch.map(d => this.fetchFullDataset(d.id, 0, d, options.registryManager))
            );
            const validResults = batchResults.filter(d => d !== null);
            if (options.onBatch) { await options.onBatch(validResults); } else { fullDatasets.push(...validResults); }

            // Circuit breaker: sustained all-fail batches (HF down/blocking) -> stop, return partial.
            if (validResults.length === 0) {
                if (++consecutiveFailBatches >= MAX_CONSECUTIVE_FAIL_BATCHES) {
                    console.warn(`   🔌 [HF Datasets] ${consecutiveFailBatches} consecutive failed batches; circuit-breaking at ${i}/${datasets.length}.`);
                    break;
                }
            } else { consecutiveFailBatches = 0; }

            // Adaptive throttle: slow down on 429, recover after clean batches
            if (this._batchHit429) {
                curBatch = Math.max(1, Math.floor(curBatch / 2));
                curDelay = Math.min(curDelay * 2, 15000);
                cleanRuns = 0;
                console.log(`   🔻 Throttle: batch=${curBatch}, delay=${curDelay}ms`);
            } else if (++cleanRuns >= 5 && (curBatch < baseBatch || curDelay > baseDelay)) {
                curBatch = Math.min(curBatch + 1, baseBatch);
                curDelay = Math.max(Math.floor(curDelay * 0.7), baseDelay);
                cleanRuns = 0;
                console.log(`   🔺 Recover: batch=${curBatch}, delay=${curDelay}ms`);
            }

            if ((i + curBatch) % 50 === 0 || i + curBatch >= datasets.length) {
                console.log(`   Progress: ${Math.min(i + curBatch, datasets.length)}/${datasets.length}`);
            }
            if (i + curBatch < datasets.length) await this.delay(curDelay);
        }

        console.log(`✅ [HF Datasets] Fetched ${options.onBatch ? datasets.length : fullDatasets.length} complete datasets`);
        return options.onBatch ? [] : fullDatasets;
    }

    /**
     * Fetch complete dataset details including README.
     * V25.9: Skips /api/datasets/{id} when expandedData has siblings.
     * V14.5: 429 retry with exponential backoff preserved.
     */
    async fetchFullDataset(datasetId, retryCount = 0, expandedData = null, registryManager = null) {
        const MAX_RETRIES = 5;
        try {
            // V28 (PR-D): removed the dead V22.4 incremental skip-unchanged branch.
            // It read `registryManager.registry?.entities`, a property the real
            // (SQLite-backed) RegistryManager never exposes, so the guard was always
            // falsy and the skip never fired. registryManager is now always undefined
            // from harvest-single (the prod streaming path). Honest: accept the
            // re-fetch, stop advertising a dead optimization. (Param kept for the
            // call-site signature; it is intentionally unused.)

            // V25.9: Skip /api/datasets/{id} if expandedData already has siblings
            let data;
            if (expandedData?.siblings) {
                data = expandedData;
            } else {
                const apiResponse = await this.fetchWithTimeout(`${HF_API_BASE}/datasets/${datasetId}`, { headers: this.getHeaders() });
                if (apiResponse.status === 429) {
                    this._batchHit429 = true;
                    if (retryCount < MAX_RETRIES) {
                        const backoff = Math.min(3000 * Math.pow(2, retryCount), 60000);
                        console.log(`   ⚠️ Rate limited (429) for ${datasetId}, retry ${retryCount + 1}/${MAX_RETRIES} after ${backoff}ms...`);
                        await this.delay(backoff);
                        return this.fetchFullDataset(datasetId, retryCount + 1, expandedData, registryManager);
                    }
                    console.warn(`   ❌ Max retries exceeded for ${datasetId}`);
                    return null;
                }
                if (!apiResponse.ok) { console.warn(`   ⚠️ API failed for ${datasetId}: ${apiResponse.status}`); return null; }
                data = await apiResponse.json();
            }

            // Fetch README content
            let readme = '';
            try {
                const readmeResponse = await this.fetchWithTimeout(`${HF_RAW_BASE}/datasets/${datasetId}/raw/main/README.md`, { headers: this.getHeaders() });
                if (readmeResponse.ok) {
                    readme = await readmeResponse.text();
                    if (readme.length > 100000) readme = readme.substring(0, 100000) + '\n\n[Content truncated...]';
                }
            } catch (e) { }

            // V25.9: Only fetch schema for datasets with >100 downloads
            let schemaData = null;
            if ((data?.downloads || expandedData?.downloads || 0) > 100) {
                try {
                    const schemaRes = await fetch(`https://datasets-server.huggingface.co/info?dataset=${datasetId}`, { headers: this.getHeaders(), signal: AbortSignal.timeout(2000) });
                    if (schemaRes.ok) { schemaData = (await schemaRes.json()).dataset_info || null; }
                } catch (e) { }
            }

            const extractedAssets = extractDatasetAssets({ ...data, readme });
            return {
                id: data.id, author: data.author, lastModified: data.lastModified, createdAt: data.createdAt,
                likes: data.likes, downloads: data.downloads, tags: data.tags,
                cardData: {
                    license: data.cardData?.license, size_category: data.cardData?.size_category,
                    task_categories: data.cardData?.task_categories, task_ids: data.cardData?.task_ids,
                    language: data.cardData?.language, multilinguality: data.cardData?.multilinguality,
                    source_datasets: data.cardData?.source_datasets, citation: data.cardData?.citation
                },
                readme, _extractedAssets: extractedAssets, _schemaData: schemaData,
                _filesCount: data.siblings?.length || 0, _fetchedAt: new Date().toISOString()
            };
        } catch (error) {
            console.warn(`   ⚠️ Error fetching dataset ${datasetId}: ${error.message}`);
            return null;
        }
    }

    /** Normalize raw HuggingFace dataset to UnifiedEntity */
    normalize(raw) {
        const datasetId = raw.id;
        const [author, name] = parseDatasetId(datasetId);
        const { schemaMarkdown, totalRows } = extractSchemaInfo(raw._schemaData);

        const entity = {
            id: this.generateId(author, name, 'dataset'),
            // C4 Stage-2 (D-333): immutable INTERNAL source-family provenance. The
            // dataset adapter's family is 'dataset'; this anchors the canonical-id
            // mint and the phantom reconciler. INTERNAL ONLY (never a public field).
            type: 'dataset', source_entity_type: 'dataset', source: 'huggingface',
            source_url: `https://huggingface.co/datasets/${datasetId}`,
            title: name,
            description: this.extractDescription(raw.readme || raw.description),
            body_content: (raw.readme || '') + schemaMarkdown,
            tags: normalizeDatasetTags(raw.tags),
            author, license_spdx: this.normalizeLicense(raw.cardData?.license),
            meta_json: buildDatasetMetaJson(raw),
            created_at: raw.createdAt, updated_at: raw.lastModified,
            task_categories: Array.isArray(raw.cardData?.task_categories) ? raw.cardData.task_categories.join(', ') : '',
            num_rows: totalRows || 0,
            primary_language: Array.isArray(raw.cardData?.language) ? raw.cardData.language[0] : (raw.cardData?.language || ''),
            popularity: raw.downloads || 0, downloads: raw.downloads || 0, likes: raw.likes || 0,
            raw_image_url: null, relations: [],
            content_hash: null, compliance_status: null, quality_score: null
        };

        const assets = raw._extractedAssets || extractDatasetAssets(raw);
        if (assets.length > 0) entity.raw_image_url = assets[0].url;

        entity.relations = this.discoverRelations(entity);
        entity.content_hash = this.generateContentHash(entity);
        entity.compliance_status = this.getComplianceStatus(entity);
        entity.quality_score = this.calculateQualityScore(entity);
        return entity;
    }

    extractAssets(raw) { return extractDatasetAssets(raw); }
    parseDatasetId(id) { return parseDatasetId(id); }
    normalizeTags(tags) { return normalizeDatasetTags(tags); }
    buildMetaJson(raw) { return buildDatasetMetaJson(raw); }
    delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    /**
     * C4 Stage-2 (D-335/336): CANDIDATE-scoped HF DATASET source-family census. For EACH
     * candidate owner, exhaust that owner's dataset listing via the REAL Link: rel="next"
     * cursor to no-next-link (NO top-N truncation). Membership-only; does not alter normal
     * harvest. COMPLETE_FOR_C4_STAGE2_CANDIDATE_UNIVERSE ONLY when EVERY owner is exhausted
     * with no unrecovered error; ANY mid-pagination failure => INCOMPLETE (partial NEVER
     * usable for deletion). deps.fetch/deps.delay injectable for hermetic tests. No token /
     * cursor URL / headers in the return; emits rehearsal metrics.
     */
    async fetchCensusMembership(options = {}) {
        const { authors = [], deps = {}, budgetMs = 20 * 60 * 1000, maxPagesPerOwner = 2000, max429Retries = 8 } = options;
        const doFetch = deps.fetch || ((url) => this.fetchWithTimeout(url, { headers: this.getHeaders() }));
        const delayFn = deps.delay || ((ms) => new Promise(r => setTimeout(r, ms)));
        const EXPECTED_HOST = 'huggingface.co', FAMILY = '/api/datasets', TYPE = 'dataset';
        const members = new Set(); const perOwner = {};
        const metrics = { source: 'huggingface-datasets', candidateOwners: authors.length, pages: 0, requests: 0, rateLimited: 0, totalWaitMs: 0, startedAt: Date.now() };
        let allExhausted = true;
        for (const author of authors) {
            const owner = String(author).toLowerCase();
            const seen = new Set(); let exhausted = false, terminatedBy = null, pages = 0;
            let url = `${HF_API_BASE}/datasets?author=${encodeURIComponent(owner)}&limit=1000`;
            try {
                while (url) {
                    if (Date.now() - metrics.startedAt > budgetMs) { terminatedBy = 'budget'; break; }
                    if (pages >= maxPagesPerOwner) { terminatedBy = 'page-guard'; break; }
                    const u = new URL(url);
                    if (u.protocol !== 'https:') throw new FetchError(this.sourceName, 'parse', 'census next url not https');
                    if (u.host !== EXPECTED_HOST) throw new FetchError(this.sourceName, 'parse', 'census host jump');
                    if (!u.pathname.startsWith(FAMILY)) throw new FetchError(this.sourceName, 'parse', 'census endpoint-family jump (models<->datasets)');
                    if ((u.searchParams.get('author') || '').toLowerCase() !== owner) { terminatedBy = 'author-jump'; throw new FetchError(this.sourceName, 'parse', 'census author-filter jump (cursor changed owner)'); }
                    if (seen.has(url)) { terminatedBy = 'cursor-loop'; throw new FetchError(this.sourceName, 'parse', 'census cursor loop'); }
                    seen.add(url); // genuine loop detection: each url is added ONCE, before any 429 retry
                    // Bounded 429 retry on the SAME url in an INNER loop that never re-enters the
                    // cursor-loop guard; an unrecovered/over-budget 429 => not exhausted => INCOMPLETE.
                    let resp = null, retries = 0;
                    while (true) {
                        if (Date.now() - metrics.startedAt > budgetMs) { terminatedBy = 'budget'; break; }
                        resp = await doFetch(url); metrics.requests++;
                        if (resp.status === 429) {
                            metrics.rateLimited++;
                            const wait = Math.min((parseInt(resp.headers.get('retry-after'), 10) || 5) * 1000, 60000);
                            metrics.totalWaitMs += wait;
                            if (++retries > max429Retries || metrics.totalWaitMs > budgetMs) { terminatedBy = '429-budget'; resp = null; break; }
                            await delayFn(wait); continue;
                        }
                        break;
                    }
                    if (!resp) break;
                    if (!resp.ok) { terminatedBy = 'http-' + resp.status; break; }
                    let page; try { page = await resp.json(); } catch { throw new FetchError(this.sourceName, 'parse', 'census page parse'); }
                    if (!Array.isArray(page)) throw new FetchError(this.sourceName, 'parse', 'census page not array');
                    for (const d of page) { const raw = d && d.id; if (raw) { if (String(raw).split('/')[0].toLowerCase() !== owner) { terminatedBy = 'owner-mismatch'; throw new FetchError(this.sourceName, 'parse', 'census repo owner mismatch (foreign namespace)'); } members.add(normalizeId(raw, 'huggingface', TYPE)); } }
                    pages++; metrics.pages++;
                    const next = parseC4S2NextLink(resp.headers.get('link'));
                    if (!next) { exhausted = true; terminatedBy = 'link-absent'; url = null; } else url = next;
                }
            } catch (e) { terminatedBy = terminatedBy || ('error:' + e.message); }
            perOwner[owner] = { exhausted, pages, terminatedBy };
            if (!exhausted) allExhausted = false;
        }
        metrics.elapsedMs = Date.now() - metrics.startedAt;
        metrics.peakRssMb = Math.round(process.memoryUsage().rss / 1048576);
        metrics.unfinishedOwners = Object.values(perOwner).filter(o => !o.exhausted).length;
        metrics.memberCount = members.size;
        metrics.withinBudget = metrics.elapsedMs <= budgetMs;
        console.log(`[C4-S2][census][datasets] owners=${authors.length} pages=${metrics.pages} req=${metrics.requests} 429=${metrics.rateLimited} wait=${metrics.totalWaitMs}ms elapsed=${metrics.elapsedMs}ms rss=${metrics.peakRssMb}MB members=${members.size} unfinished=${metrics.unfinishedOwners} exhausted=${allExhausted}`);
        return { members: Array.from(members).sort(), perOwner, completeness: allExhausted ? COMPLETE_FOR_C4_STAGE2_CANDIDATE_UNIVERSE : 'INCOMPLETE', allExhausted, metrics };
    }
}

export default DatasetsAdapter;
