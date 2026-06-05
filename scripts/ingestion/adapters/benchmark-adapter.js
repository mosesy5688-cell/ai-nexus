/**
 * Benchmark Adapter (5th entity type)
 *
 * Promotes the Open LLM Leaderboard v2 sub-benchmarks (IFEval / BBH / MATH Lvl 5
 * / GPQA / MUSR / MMLU-PRO) to FIRST-CLASS benchmark nodes. This is an
 * identity-edge generator, NOT a breadth harvester: each node anchors the
 * `EVALUATED_ON: model->benchmark` edge that connects the whole model corpus to
 * ~6 canonical benchmarks (the edge itself is emitted in relation-extractors.js
 * from per-model scores; this adapter mints the TARGET nodes so the edge is not
 * an orphan).
 *
 * Source = a hand-curated seed catalog (data/benchmark-catalog.json), NOT a
 * scrape. honest-contract:
 *  - name/description carry "as measured by Open LLM Leaderboard v2" provenance;
 *    never a bare "MMLU" that would imply coverage beyond the 6 sub-benchmarks.
 *  - arxiv_id / hf_dataset_id are surfaced (driving CITES / USES) ONLY where the
 *    catalog has a verifiable conf-1.0 value; a null is left null, never invented.
 *  - the leaderboard snapshot is FROZEN: the node honestly discloses
 *    "frozen snapshot, as-of <epoch>" rather than a freshness signal it cannot
 *    keep current.
 *
 * @module ingestion/adapters/benchmark-adapter
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BaseAdapter } from './base-adapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Catalog lives next to the adapter (NOT a data/ subdir — that path is
// .gitignore'd by the broad `data/` rule, which would drop it from CI).
const CATALOG_PATH = process.env.BENCHMARK_CATALOG_PATH
    || path.join(__dirname, 'benchmark-catalog.json');

const LEADERBOARD_NAME = 'Open LLM Leaderboard v2';
const LEADERBOARD_URL = 'https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard';

export class BenchmarkAdapter extends BaseAdapter {
    constructor() {
        // sourceName 'openllm' makes generateId mint benchmark--openllm--<col>
        // and matches SOURCE_AUTHORITY ('openllm') in cross-platform-dedup.js.
        super('openllm');
        this.entityTypes = ['benchmark'];
    }

    /**
     * "Fetch" = read the local curated catalog and stream its rows. No network:
     * the catalog is the authoritative, stable, small ( ~6 row) seed. Each row is
     * handed to normalize() by the harvester.
     * @param {Object} options
     * @param {Function} [options.onBatch]
     */
    async fetch(options = {}) {
        const { onBatch } = options;
        const rows = this.loadCatalog();
        if (rows.length === 0) {
            console.warn('   [Benchmark] Catalog empty/unreadable — emitting nothing (honest fail-open).');
            return [];
        }
        console.log(`   [Benchmark] Loaded ${rows.length} curated benchmarks from catalog.`);
        if (onBatch) {
            await onBatch(rows);
            return [];
        }
        return rows;
    }

    /** Load + validate the curated catalog. Returns [] on any error (never throws). */
    loadCatalog() {
        try {
            const raw = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8'));
            const list = Array.isArray(raw?.benchmarks) ? raw.benchmarks : [];
            // Only rows with a leaderboard_col are valid (it is the single source of
            // truth for the node id and the EVALUATED_ON edge target — drift = orphan).
            return list.filter((r) => r && typeof r.leaderboard_col === 'string' && r.leaderboard_col.length > 0);
        } catch (e) {
            console.warn(`   [Benchmark] Catalog load failed (${CATALOG_PATH}): ${e.message}`);
            return [];
        }
    }

    /**
     * Normalize one catalog row -> benchmark entity.
     * Key alignment (panel R7): id suffix == slug == leaderboard_col == the
     * EVALUATED_ON edge target suffix, all derived from the single `leaderboard_col`.
     * @param {Object} raw
     */
    normalize(raw) {
        if (!raw || !raw.leaderboard_col) return null;
        const col = raw.leaderboard_col;
        const id = this.generateId('openllm', col, 'benchmark'); // benchmark--openllm--<col>
        const slug = `openllm--${col}`;                          // stripPrefix(id)
        const displayName = raw.name || col;

        // honest-contract: the leaderboard is a frozen snapshot. We store the
        // harvest epoch (no per-row eval date is exposed by the catalog) and
        // DISCLOSE it as a frozen snapshot rather than imply live freshness.
        const evaluatedAt = new Date().toISOString();
        const provenance = `${displayName} as measured by ${LEADERBOARD_NAME}`;
        const description = `${provenance}. Evaluation benchmark for ${raw.task || 'language model capability'}`
            + (raw.metric ? ` (metric: ${raw.metric})` : '')
            + `. Frozen leaderboard snapshot, as-of ${evaluatedAt.slice(0, 10)}; scores are not continuously refreshed.`;

        // paper_ref -> arxiv_refs (drives CITES); dataset_ref -> datasets (drives
        // USES via the benchmark type-guard). null stays absent — never fabricated.
        const arxivRefs = raw.arxiv_id ? [String(raw.arxiv_id)] : [];
        const datasets = raw.hf_dataset_id ? [String(raw.hf_dataset_id)] : [];

        return {
            id,
            slug,
            type: 'benchmark',
            source: 'open_llm_leaderboard',
            source_url: LEADERBOARD_URL,
            name: displayName,
            title: displayName,
            description,
            category: 'benchmark',
            task_categories: raw.task || '',
            arxiv_refs: arxivRefs,
            datasets,
            // Honest snapshot disclosure surfaced as structured fields (consumed by
            // detail page / API): epoch + frozen flag + source. Never a top_model.
            leaderboard_epoch: evaluatedAt,
            evaluated_at: evaluatedAt,
            is_frozen_snapshot: true,
            leaderboard_source: LEADERBOARD_NAME,
            tags: ['benchmark', 'evaluation', col],
            relations: [],
            content_hash: null,
            compliance_status: 'ok',
        };
    }

    extractAssets() { return []; }
}

export default BenchmarkAdapter;
