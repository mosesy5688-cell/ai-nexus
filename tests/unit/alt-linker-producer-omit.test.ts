/**
 * ALT-LINKER-PRODUCER-OMIT (D-375 PRODUCER_OMIT_ZERO_RELATION_FRAME)
 *
 * DEFECT: the Rust alt-linker wrote a per-category `alt-by-category/<cat>.json.zst`
 * for EVERY category with >=1 entity. A category with 0 relations serializes to a
 * bare `[]` (2 bytes) -> zstd -> ~11-byte frame, which is BELOW the r2-handoff `.zst`
 * upload floor (a `.zst` must be >= 16 bytes with a valid zstd magic). r2-handoff then
 * fail-closes the whole Factory 3/4 Aggregate job on that legitimate empty frame.
 *
 * FIX: the producer (Rust + the JS fallback + the JS physical write boundary) no longer
 * EMITS a payload frame for a zero-relation category. The category stays in the meta
 * census (entity_count + relation_count=0). Consumers already treat an absent category
 * identically to a present-empty one. The general `.zst` loud-fail gate is UNCHANGED.
 *
 * These tests exercise the REAL exported `computeAltRelations`: the Rust FFI seam is
 * mocked so we control Rust-available (physical fence) vs Rust-absent (JS fallback),
 * and a third test locks the general `.zst` upload gate so the fix cannot weaken it.
 * The "no file for a zero-relation category" assertions go RED if the omit is reverted
 * (the empty frame reappears) — the required RED-then-restore property.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mutable Rust-FFI seam (hoisted so the vi.mock factory can close over it).
const rustSeam = vi.hoisted(() => ({ fromDir: null as unknown }));

// alt-linker.js imports exactly these two exports; computeAltRelationsFromDirFFI's
// return value decides Rust-vs-fallback (a truthy result with categoriesData+metaData
// takes the Rust write path; null selects the JS fallback).
vi.mock('../../scripts/factory/lib/rust-bridge.js', () => ({
    computeAltRelationsFromDirFFI: (_shardDir: string, _outDir: string) => rustSeam.fromDir,
    computeAltRelationsFFI: () => null,
}));

import { computeAltRelations } from '../../scripts/factory/lib/alt-linker.js';
import { isUploadEligible } from '../../scripts/factory/lib/upload-eligibility.js';
import { zstdCompress } from '../../scripts/factory/lib/zstd-helper.js';

function altFile(tmp: string, name: string) {
    return path.join(tmp, 'cache', 'relations', 'alt-by-category', name);
}
function metaFile(tmp: string) {
    return path.join(tmp, 'cache', 'relations', 'alt-meta.json.zst');
}

/** Stream a fixed entity array to the consumer in ordered batches. */
function makeShardReader(entities: any[], batchSize = 1000) {
    return async (consumer: (batch: any[]) => Promise<void>, _opts?: unknown) => {
        for (let i = 0; i < entities.length; i += batchSize) {
            await consumer(entities.slice(i, i + batchSize));
        }
    };
}

let tmp: string;
beforeEach(() => {
    rustSeam.fromDir = null;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alt-omit-'));
});
afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('ALT-LINKER-PRODUCER-OMIT — Rust-path physical fence (D-375)', () => {
    it('omits a zero-relation frame even when a stale .node still RETURNS one', async () => {
        // Simulate an OLD cached .node that still returns the empty payload. The JS
        // physical fence (relationCount === 0 -> continue) must drop it anyway, so
        // correctness never depends on the native cache being refreshed.
        rustSeam.fromDir = {
            categoriesData: [
                { filename: 'empty-cat.json.zst', compressedData: new Uint8Array([1, 2, 3]), relationCount: 0 },
                { filename: 'real-cat.json.zst', compressedData: new Uint8Array([4, 5, 6, 7]), relationCount: 5 },
            ],
            metaData: new Uint8Array([8, 9, 10]),
            totalRelations: 5,
        };
        const shardReaderSpy = vi.fn(async () => { /* must NOT run on the Rust path */ });

        const res = await computeAltRelations(shardReaderSpy as any, tmp, { shardDir: '/fake/shards' });

        expect(fs.existsSync(altFile(tmp, 'empty-cat.json.zst'))).toBe(false); // OMITTED
        expect(fs.existsSync(altFile(tmp, 'real-cat.json.zst'))).toBe(true);   // emitted
        expect(fs.existsSync(metaFile(tmp))).toBe(true);                       // census written
        expect(res.totalRelations).toBe(5);
        expect(shardReaderSpy).not.toHaveBeenCalled();
    });
});

describe('ALT-LINKER-PRODUCER-OMIT — JS fallback omit (D-375)', () => {
    it('omits the zero-relation category yet keeps its census count', async () => {
        rustSeam.fromDir = null; // FFI null -> JS fallback selected
        // "emptycat": empty tags -> no candidates -> 0 relations (mirrors the Rust
        // `source_tags.is_empty()` guard). "realcat": shared tags -> relations. Only
        // the zero-relation category must be omitted from disk.
        const entities = [
            { id: 'z1', slug: 'z1', primary_category: 'emptycat', type: 'model', fni_score: 1, tags: [] },
            { id: 'z2', slug: 'z2', primary_category: 'emptycat', type: 'model', fni_score: 1, tags: [] },
            { id: 'r1', slug: 'r1', primary_category: 'realcat', type: 'model', fni_score: 1, tags: ['x', 'y'] },
            { id: 'r2', slug: 'r2', primary_category: 'realcat', type: 'model', fni_score: 1, tags: ['x', 'y'] },
        ];

        const res = await computeAltRelations(makeShardReader(entities) as any, tmp, { shardDir: '/fake/shards' });

        expect(fs.existsSync(altFile(tmp, 'emptycat.json.zst'))).toBe(false); // OMITTED
        expect(fs.existsSync(altFile(tmp, 'realcat.json.zst'))).toBe(true);   // emitted
        expect(res.byCategoryCount['emptycat']).toBe(0);                      // census preserved
        expect(res.byCategoryCount['realcat']).toBeGreaterThan(0);
    });
});

describe('ALT-LINKER-PRODUCER-OMIT — general .zst upload gate NOT weakened (D-375)', () => {
    it('the loud-fail floor still refuses empty / bad-magic / truncated .zst', async () => {
        // (a) a REAL ~11-byte zstd frame of `[]` (exactly the sub-16B empty frame the
        //     fix omits at the producer) is still INELIGIBLE at the upload gate.
        const emptyFrame = await zstdCompress(JSON.stringify([]));
        expect(emptyFrame.length).toBeLessThan(16);
        expect(isUploadEligible('cache/relations/alt-by-category/x.json.zst', emptyFrame).eligible).toBe(false);

        // (b) a 20-byte buffer with a non-zstd magic is INELIGIBLE (size alone never rescues a .zst).
        expect(isUploadEligible('x.json.zst', Buffer.alloc(20)).eligible).toBe(false);

        // (c) a truncated .zst (valid magic prefix but < 16 bytes) is INELIGIBLE.
        const truncated = Buffer.from([0x28, 0xB5, 0x2F, 0xFD, 1, 2, 3]);
        expect(isUploadEligible('x.json.zst', truncated).eligible).toBe(false);

        // sanity: a real >= 16B zstd frame IS still eligible — the gate did not start rejecting real data.
        const realFrame = await zstdCompress(JSON.stringify([{ source_id: 'a', category: 'c', alts: [['b', 90]] }]));
        expect(realFrame.length).toBeGreaterThanOrEqual(16);
        expect(isUploadEligible('x.json.zst', realFrame).eligible).toBe(true);
    });
});
