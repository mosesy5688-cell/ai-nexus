/**
 * ALT-LINKER-FALLBACK-PARITY (D-253 / D-254 / D-255)
 *
 * DEFECT (D-253 §C): scripts/factory/lib/alt-linker.js `computeAltRelations`
 * JS fallback had a hard `const MAX_PER_CATEGORY = 5000` ingestion gate
 * (`if (byCategory[category].length < MAX_PER_CATEGORY) push`). The Rust path
 * (rust/satellite-tasks/src/alt_linker.rs `compute_alt_relations_from_dir`)
 * has NO ingestion cap — it accumulates the FULL category population as slim
 * tuples (id, fni_score, tags) and THEN sorts by fni_score and truncates to the
 * top MAX_PER_CATEGORY(=500). So when the Rust crate is ABSENT and the JS
 * fallback runs, every entity streamed after the 5000th was SILENTLY DROPPED
 * from the top-500-by-fni selection Rust would have made — a truncation
 * divergence, not parity.
 *
 * FIX (option A, full-population parity): remove the JS ingestion cap so the JS
 * fallback considers the full population exactly like Rust, bounded only by the
 * SAME top-500-by-fni guard Rust uses (in computeCategoryAlts, maxEntities=500),
 * while keeping only the slim fields Rust keeps (id/slug/fni_score/tags/type) so
 * memory stays bounded like Rust's slim tuples. Silent truncation is forbidden.
 *
 * These tests exercise the REAL fallback-selection dispatch inside the exported
 * `computeAltRelations` (not a private helper): the Rust FFI seam is mocked so
 * we control Rust-available vs Rust-absent, and we assert the >5000/category
 * fallback does NOT silently truncate. Evidence class: EXEC (real module + mock
 * seam, no network) + SOURCE (silent-truncation regex lock).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Mutable Rust-FFI seam state (hoisted so the vi.mock factory can close over it).
const rustSeam = vi.hoisted(() => ({ result: null as unknown, calls: 0 }));

// Replace ONLY alt-linker's rust-bridge import. alt-linker uses exactly these
// two exports; computeAltRelationsFromDirFFI's return decides Rust-vs-fallback.
vi.mock('../../scripts/factory/lib/rust-bridge.js', () => ({
    computeAltRelationsFromDirFFI: (_shardDir: string, _outDir: string) => {
        rustSeam.calls++;
        return rustSeam.result;
    },
    computeAltRelationsFFI: () => null,
}));

import { computeAltRelations } from '../../scripts/factory/lib/alt-linker.js';
import { zstdDecompress } from '../../scripts/factory/lib/zstd-helper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

/** Stream a fixed entity array to the consumer in ordered batches (preserves
 *  stream order, which is what the >5000 truncation discriminator depends on). */
function makeShardReader(entities: any[], batchSize = 1000) {
    return async (consumer: (batch: any[]) => Promise<void>, _opts?: unknown) => {
        for (let i = 0; i < entities.length; i += batchSize) {
            await consumer(entities.slice(i, i + batchSize));
        }
    };
}

async function readCategory(outDir: string, safeCat: string) {
    const p = path.join(outDir, 'cache', 'relations', 'alt-by-category', `${safeCat}.json.zst`);
    const raw = await zstdDecompress(fs.readFileSync(p));
    return JSON.parse(raw.toString('utf-8'));
}

let tmp: string;
beforeEach(() => {
    rustSeam.result = null;
    rustSeam.calls = 0;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alt-parity-'));
});
afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('ALT-LINKER-FALLBACK-PARITY — dispatch selection (D-254 §F/§G)', () => {
    it('Rust-AVAILABLE: uses the Rust FFI result, never the JS fallback', async () => {
        rustSeam.result = {
            categoriesData: [{ filename: 'text-generation.json.zst', compressedData: new Uint8Array([1, 2, 3]) }],
            metaData: new Uint8Array([4, 5, 6]),
            totalRelations: 4242,
        };
        const shardReaderSpy = vi.fn(async () => { /* must NOT be invoked */ });

        const res = await computeAltRelations(shardReaderSpy as any, tmp, { shardDir: '/fake/shards' });

        expect(rustSeam.calls).toBe(1);          // FFI was consulted
        expect(res.totalRelations).toBe(4242);   // Rust result propagated
        expect(shardReaderSpy).not.toHaveBeenCalled(); // JS grouping/fallback skipped
    });

    it('Rust-UNAVAILABLE (FFI null) with shardDir set: SELECTS the JS fallback', async () => {
        rustSeam.result = null; // satellite-tasks crate absent / FFI threw -> null
        const shardReaderSpy = vi.fn(makeShardReader([
            { id: 'a', slug: 'a', primary_category: 'cat', type: 'model', fni_score: 1, tags: ['x', 'y'] },
            { id: 'b', slug: 'b', primary_category: 'cat', type: 'model', fni_score: 1, tags: ['x', 'y'] },
        ]));

        const res = await computeAltRelations(shardReaderSpy as any, tmp, { shardDir: '/fake/shards' });

        expect(rustSeam.calls).toBe(1);              // FFI consulted, returned null
        expect(shardReaderSpy).toHaveBeenCalledTimes(1); // fallback streaming ran
        expect(res.totalRelations).toBeGreaterThan(0);   // and produced the full set
    });
});

describe('ALT-LINKER-FALLBACK-PARITY — no silent truncation past 5000 (D-254 §F items 4/7)', () => {
    it('a >5000-entity category keeps the high-FNI cohort streamed AFTER the 5000th', async () => {
        // First 5000 entities: unique tags (no relations possible), LOW fni.
        // Under the old cap these fill the buffer and the later cohort is dropped.
        const lo: any[] = [];
        for (let i = 0; i < 5000; i++) {
            lo.push({ id: `locohort${i}`, slug: `locohort${i}`, primary_category: 'cat', type: 'model', fni_score: 1, tags: [`uniqlo${i}`] });
        }
        // Entities 5000..5999: shared tags (Jaccard 1.0 -> relations), HIGH fni ->
        // these are the TRUE top-500-by-fni Rust would select. Old cap dropped them.
        const hi: any[] = [];
        for (let i = 0; i < 1000; i++) {
            hi.push({ id: `hicohort${i}`, slug: `hicohort${i}`, primary_category: 'cat', type: 'model', fni_score: 100, tags: ['shareda', 'sharedb'] });
        }
        const shardReader = makeShardReader([...lo, ...hi]);

        const res = await computeAltRelations(shardReader as any, tmp, { shardDir: '/fake/shards' });

        // Fixed behavior: full population -> top-500-by-fni = the hi cohort -> relations.
        // OLD (capped) behavior would be exactly 0 relations (first-5000 have unique tags).
        expect(res.totalRelations).toBeGreaterThan(0);
        expect(res.byCategoryCount['cat']).toBeGreaterThan(0);

        const out = await readCategory(tmp, 'cat');
        expect(out.relations.length).toBeGreaterThan(0);
        // Every emitted source_id must come from the beyond-5000 high-FNI cohort;
        // the first-5000 low-FNI unique-tag cohort produces no relations at all.
        for (const rel of out.relations) {
            expect(String(rel.source_id)).toContain('hicohort');
            expect(String(rel.source_id)).not.toContain('locohort');
        }
    });

    it('PERF GUARD (D-254 §H): a 12000-entity single category completes with bounded memory', async () => {
        const big: any[] = [];
        for (let i = 0; i < 12000; i++) {
            big.push({ id: `e${i}`, slug: `e${i}`, primary_category: 'cat', type: 'model', fni_score: i, tags: ['t1', 't2', `t${i % 50}`] });
        }
        const before = process.memoryUsage().heapUsed;
        const res = await computeAltRelations(makeShardReader(big) as any, tmp, { shardDir: '/fake/shards' });
        const deltaMB = (process.memoryUsage().heapUsed - before) / (1024 * 1024);
        // Slim-tuple accumulation (parity with Rust) -> no obvious blow-up for 12k entities.
        console.log(`[ALT-PARITY perf] 12k single-category fallback heap delta ~= ${deltaMB.toFixed(1)} MB, relations=${res.totalRelations}`);
        expect(res.totalRelations).toBeGreaterThan(0);
        expect(deltaMB).toBeLessThan(400); // runaway detector, not a benchmark
    });
});

describe('ALT-LINKER-FALLBACK-PARITY — source lock (D-254 §F item 6)', () => {
    it('alt-linker.js no longer contains the MAX_PER_CATEGORY ingestion truncation', () => {
        const src = readFileSync(path.join(repoRoot, 'scripts/factory/lib/alt-linker.js'), 'utf-8');
        // The removed silent-truncation CODE MUST NOT come back (the explanatory
        // comment may still name the old constant, so match code, not the token).
        expect(src).not.toMatch(/const\s+MAX_PER_CATEGORY\s*=/);
        expect(src).not.toMatch(/length\s*<\s*MAX_PER_CATEGORY/);
        expect(src).not.toMatch(/length\s*<\s*\d+\s*\)\s*byCategory\[category\]\.push/);
        // Full-population push (slim projection) IS present.
        expect(src).toMatch(/byCategory\[category\]\.push\(\{[^}]*fni_score/);
    });
});
