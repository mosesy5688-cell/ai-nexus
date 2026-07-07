/**
 * Trend Data Generator
 * V14.5 Phase 5: Generates trend-data.json for frontend charts
 *
 * Input: FNI history (7-day rolling scores) — a materialized { entities } object
 *        (legacy satellite `--task=trend`) OR a streaming source { stream } that
 *        yields [id, history] pairs without holding the whole ~1.9GB history in
 *        memory (core finalization, D-295 Component 4/5).
 * Output: trend-data.json with scores, change%, and direction — top-50000 by latest
 *         FNI score (unchanged contract).
 *
 * Constitution: Art 6.3 (Client-side only)
 */

import fs from 'fs/promises';
import path from 'path';
import { smartWriteWithVersioning } from './smart-writer.js';

// Unchanged cap: high-density top-50000 by latest FNI score (contract).
export const TREND_TOP_K = 50000;

/**
 * Bounded top-K min-heap (D-295 Component 4). Keeps the K most-preferred entities
 * by (latestScore DESC, insertionIndex ASC). This is BYTE-IDENTICAL to the legacy
 * `Object.entries(...).sort((a,b)=>bLatest-aLatest).slice(0, K)`: V8's Array.sort is
 * stable, so equal scores retain input (insertion) order and `.slice` keeps the
 * earliest-inserted. The heap root is the LEAST preferred element (min score; among
 * ties the MAX insertionIndex) so it is the one evicted first. Because insertionIndex
 * is monotonic, an incoming equal-score element is never preferred over an incumbent —
 * exactly the stable-sort tie rule. Peak memory is O(K), not O(N).
 */
export class TopKHeap {
    constructor(k) { this.k = k; this.a = []; }
    // true when x is LESS preferred than y (x sorts closer to the evict-root).
    _less(x, y) { return x.score < y.score || (x.score === y.score && x.idx > y.idx); }
    _swap(i, j) { const t = this.a[i]; this.a[i] = this.a[j]; this.a[j] = t; }
    _up(i) { while (i > 0) { const p = (i - 1) >> 1; if (this._less(this.a[i], this.a[p])) { this._swap(i, p); i = p; } else break; } }
    _down(i) {
        const n = this.a.length;
        for (;;) {
            let s = i; const l = 2 * i + 1, r = 2 * i + 2;
            if (l < n && this._less(this.a[l], this.a[s])) s = l;
            if (r < n && this._less(this.a[r], this.a[s])) s = r;
            if (s === i) break;
            this._swap(i, s); i = s;
        }
    }
    offer(item) {
        if (this.a.length < this.k) { this.a.push(item); this._up(this.a.length - 1); return; }
        // Heap full: replace the least-preferred root only if item STRICTLY beats it.
        // Equal-score items lose (higher monotonic idx) — matches stable-sort + slice.
        if (item.score > this.a[0].score) { this.a[0] = item; this._down(0); }
    }
    drain() { return this.a; }
}

/**
 * Iterate a trend source in the canonical order (loadFniHistory's Object.entries
 * order). `fniSource.stream(cb)` is the bounded streaming reader; the legacy
 * `{ entities }` object path preserves Object.keys === Object.entries order.
 */
async function forEachEntity(fniSource, onEntity) {
    if (fniSource && typeof fniSource.stream === 'function') {
        await fniSource.stream(onEntity);
        return;
    }
    const entities = fniSource?.entities || {};
    for (const id of Object.keys(entities)) onEntity(id, entities[id]);
}

/**
 * Generate trend data from FNI history.
 * @param {Object} fniSource - { entities } object OR { stream(cb) } reader
 * @param {string} outputDir - Output directory (default: output/cache)
 * @returns {Promise<Object>} - Generated trend data stats
 */
export async function generateTrendData(fniSource, outputDir = 'output/cache') {
    console.log('[TREND] Generating trend data...');

    // Bounded pass: feed every entity into the top-K heap; never materialize a
    // full entries array or a full sorted copy (the legacy ~2x driver).
    const heap = new TopKHeap(TREND_TOP_K);
    let idx = 0, totalSeen = 0;
    await forEachEntity(fniSource, (id, history) => {
        totalSeen++;
        const i = idx++;
        if (!history || history.length < 2) return;
        const score = history[history.length - 1]?.score || 0;
        heap.offer({ id, history, score, idx: i });
    });

    // Emit in the same order as legacy stable-sort + slice: score DESC, idx ASC.
    const selected = heap.drain().slice().sort((a, b) => (b.score - a.score) || (a.idx - b.idx));

    const trendData = {};
    for (const { id, history } of selected) {
        const scores = history.map(h => h.score);
        const dates = history.map(h => h.date);
        const latest = scores[scores.length - 1];
        const oldest = scores[0];

        // Calculate 7-day change percentage
        let change7d = 0;
        if (oldest > 0) {
            change7d = parseFloat(((latest - oldest) / oldest * 100).toFixed(1));
        }

        // Determine direction
        let direction = 'stable';
        if (change7d > 1) direction = 'up';
        else if (change7d < -1) direction = 'down';

        trendData[id] = {
            scores: scores.slice(-7),
            dates: dates.slice(-7),
            change7d,
            direction,
            latest
        };
    }

    const processedCount = selected.length;
    const skippedCount = totalSeen - processedCount;

    // Ensure output directory exists
    const trendPath = path.join(outputDir, 'trend-data.json.zst');
    await fs.mkdir(path.dirname(trendPath), { recursive: true });

    // Write trend data (Zstd via SmartWriter)
    await smartWriteWithVersioning('trend-data.json', trendData, outputDir, { compress: true });

    const fileSize = (await fs.stat(trendPath)).size;

    console.log(`[TREND] ✅ Generated trend-data.json`);
    console.log(`  - Entities: ${processedCount}`);
    console.log(`  - Skipped: ${skippedCount}`);
    console.log(`  - Size: ${(fileSize / 1024).toFixed(1)} KB`);

    return {
        processed: processedCount,
        skipped: skippedCount,
        fileSizeBytes: fileSize,
        path: trendPath
    };
}

export default generateTrendData;
