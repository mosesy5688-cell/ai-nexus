/**
 * List Preload Emitter (Architecture B Phase 1)
 *
 * Emits a lean, FRESH static top-N artifact per ranking group from the live
 * build-sorted `groups` (same source that feeds rankings-<type>.db). The SSR
 * list pages prefer this artifact over cold wa-sqlite, eliminating the cold
 * isolate -> 15s timeout -> empty-page loop incident.
 *
 * Additive only: does not alter any existing pipeline output. Writes to
 * data/list-preload/<group>.json.zst (Zstd via smartWriteWithVersioning).
 * The data/ prefix is already covered by R2_PREFIX_FILTER, so it uploads.
 *
 * The card objects carry ONLY the columns the SSR rankings/category SELECT
 * pulls, so DataNormalizer.normalizeCollection + truncateListingItem on the
 * consumer produce output identical to the wa-sqlite path.
 */

import { smartWriteWithVersioning } from './smart-writer.js';

// Top-N per group. Entity list pages slice to 48; the [category].astro page
// slices to 100. Emit 100 to cover the largest first-paint need.
const PRELOAD_TOP_N = 100;

/**
 * Project a slim build entity to the lean card shape consumed by the grid.
 * Mirrors the rankings/category SQL SELECT columns in catalog-fetcher.js.
 * @param {Object} e - build entity (already enriched + fni-sorted)
 * @returns {Object} lean card row
 */
function toCardRow(e) {
    const summary = e.description || e.summary || '';
    return {
        id: e.id,
        name: e.name || e.slug || '',
        type: e.type || 'model',
        author: e.author || '',
        summary: typeof summary === 'string' ? summary.substring(0, 200) : '',
        fni_score: e.fni_score ?? e.fni ?? 0,
        downloads: e.downloads || 0,
        stars: e.stars || 0,
        params_billions: e.params_billions ?? 0,
        context_length: e.context_length ?? 0,
        last_updated: e.last_modified || '',
        category: e.category || '',
        pipeline_tag: e.pipeline_tag || '',
        license: e.license || '',
        vram_estimate_gb: e.vram_estimate_gb || 0,
        architecture: typeof e.architecture === 'string' ? e.architecture : '',
        task_categories: typeof e.task_categories === 'string' ? e.task_categories : '',
        num_rows: e.num_rows || 0,
        primary_language: e.primary_language || '',
        forks: e.forks || 0,
        citation_count: e.citation_count || 0
    };
}

/**
 * Emit one lean preload artifact per non-empty group.
 * @param {Object<string, Array>} groups - build-sorted groups (fni desc)
 * @param {string} outputDir - factory output dir (artifact goes under data/)
 * @returns {Promise<number>} number of artifacts written
 */
export async function emitListPreload(groups, outputDir) {
    let written = 0;
    const generated = new Date().toISOString();

    for (const [groupName, entities] of Object.entries(groups)) {
        if (!Array.isArray(entities) || !entities.length) continue;

        const items = entities.slice(0, PRELOAD_TOP_N).map(toCardRow);
        const payload = {
            group: groupName,
            generated,
            totalEntities: entities.length,
            items
        };

        // compress:true -> Zstd via smart-writer/zstd-helper; final key .json.zst
        await smartWriteWithVersioning(
            `data/list-preload/${groupName}.json`,
            payload,
            outputDir,
            { compress: true }
        );
        written++;
    }

    console.log(`[LIST-PRELOAD] Emitted ${written} preload artifacts to data/list-preload/`);
    return written;
}
