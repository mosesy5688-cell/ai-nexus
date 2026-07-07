// scripts/factory/aggregate-bounded-finalization.test.mjs
//
// Hermetic node:test suite for the Factory 3/4 finalization bounded-footprint
// repair (Founder ruling D-2026-0707-295, PR-A). NO network, NO R2, NO @aws-sdk:
// pure functions + real temp dirs (node built-ins + local zstd only).
//
// ANTI-VACUITY MAP (removing/weakening a guard reds >=1 named test):
//   * df-gate fail-closed (C1)      -> (G1) free < peak+margin => ok=false + terminal code;
//                                      make the gate warning-only / always-ok => G1 flips green-when-broke.
//   * df-gate is MEASURED not const -> (G2) doubling measured sizes doubles the estimate; a constant estimate
//                                      => G2 reds. (G3) margin is enforced (free==peak w/o margin still fails).
//   * bounded top-K == stable slice -> (T1) heap selection id-order == legacy Object.entries().sort().slice(0,50000);
//                                      drop the idx tie-break => tie-boundary reds.
//   * written artifact == legacy     -> (T2) >50000 fixture: object/stream generateTrendData write a .zst BYTE-identical
//                                      to the legacy full-then-slice write; also determinism (same bytes twice).
//   * stream path == object path     -> (T2) stream .zst === object .zst === legacy .zst.
//   * top-50000 selection unchanged  -> (T1 50000 ids) + (T2 legacy has exactly 50000 keys).
//   * semantic JSON shape/order      -> (T3) small fixture decompresses to the legacy JSON byte-for-byte (key order+values).
//   * FNI stream order contract      -> (S1) streamFniHistoryEntities yields sorted-shard + in-shard key order.
//   * resource read fail-loud (C3)   -> (S2) a corrupt present shard REJECTS (not swallowed); (S3) missing dir is the
//                                      only non-fatal cold-start case. Wrap the shard read in swallow-catch => S2 greens.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    TopKHeap,
    TREND_TOP_K,
    generateTrendData,
} from './lib/trend-data-generator.js';
import {
    estimateFinalizationPeakBytes,
    evaluateDiskGate,
    streamFniHistoryEntities,
    DISK_GATE_TERMINAL_CODE,
    FINALIZATION_MARGIN_BYTES,
    FINALIZATION_SAFETY_FACTOR,
} from './lib/aggregator-maintenance.js';
import { smartWriteWithVersioning } from './lib/smart-writer.js';
import { zstdCompress, autoDecompress } from './lib/zstd-helper.js';

// ---------- fixtures ----------------------------------------------------------

// Non-integer keys (id-XXXX) so JS preserves INSERTION order (integer-like keys
// would be reordered numerically, breaking the stable-sort tie contract).
function buildEntities({ unique = 40000, tie = 20000, filtered = 1000, tieScore = 500 } = {}) {
    const e = {};
    let n = 0;
    for (let i = 0; i < unique; i++) {
        const R = 1_000_000 - i; // all distinct, all > tieScore
        e[`id-${String(n++).padStart(7, '0')}`] = [
            { date: '2026-07-01', score: Math.max(1, R - 1) },
            { date: '2026-07-02', score: R },
        ];
    }
    for (let i = 0; i < tie; i++) {
        e[`id-${String(n++).padStart(7, '0')}`] = [
            { date: '2026-07-01', score: tieScore - 1 },
            { date: '2026-07-02', score: tieScore },
        ];
    }
    for (let i = 0; i < filtered; i++) {
        e[`id-${String(n++).padStart(7, '0')}`] = [{ date: '2026-07-02', score: tieScore }]; // length 1 => filtered
    }
    return e;
}

// EXACT legacy algorithm (verbatim from pre-D-295 trend-data-generator.js).
function legacyTrendData(entities) {
    const sortedEntities = Object.entries(entities)
        .filter(([, history]) => history && history.length >= 2)
        .sort((a, b) => {
            const aLatest = a[1][a[1].length - 1]?.score || 0;
            const bLatest = b[1][b[1].length - 1]?.score || 0;
            return bLatest - aLatest;
        })
        .slice(0, 50000);
    const trendData = {};
    for (const [id, history] of sortedEntities) {
        const scores = history.map(h => h.score);
        const dates = history.map(h => h.date);
        const latest = scores[scores.length - 1];
        const oldest = scores[0];
        let change7d = 0;
        if (oldest > 0) change7d = parseFloat(((latest - oldest) / oldest * 100).toFixed(1));
        let direction = 'stable';
        if (change7d > 1) direction = 'up';
        else if (change7d < -1) direction = 'down';
        trendData[id] = { scores: scores.slice(-7), dates: dates.slice(-7), change7d, direction, latest };
    }
    return trendData;
}

const streamOf = (entities) => ({ stream: (cb) => { for (const id of Object.keys(entities)) cb(id, entities[id]); } });
async function mkTmp(label) { return await fs.mkdtemp(path.join(os.tmpdir(), `prA-${label}-`)); }
async function readBytes(dir) { return await fs.readFile(path.join(dir, 'trend-data.json.zst')); }

// ---------- Component 1: df-gate ---------------------------------------------

test('G1: df-gate FAILS CLOSED when free < estimated peak + margin (terminal code)', () => {
    const sizes = { fniBytes: 3 * 1e9, regBytes: 1 * 1e9, trendBytes: 0.5e9 }; // 4.5 GB base
    const peak = estimateFinalizationPeakBytes(sizes);
    const r = evaluateDiskGate({ freeBytes: peak + FINALIZATION_MARGIN_BYTES - 1, sizes });
    assert.equal(r.ok, false, 'one byte below required must fail closed');
    assert.equal(r.terminalCode, DISK_GATE_TERMINAL_CODE);
    assert.equal(r.terminalCode, 'INSUFFICIENT_RUNNER_DISK_FINALIZATION');
    for (const k of ['measuredFreeBytes', 'estimatedPeakBytes', 'requiredMarginBytes', 'requiredTotalBytes']) {
        assert.equal(typeof r[k], 'number');
    }
    const ok = evaluateDiskGate({ freeBytes: peak + FINALIZATION_MARGIN_BYTES, sizes });
    assert.equal(ok.ok, true, 'exactly peak+margin must pass');
});

test('G2: estimate is MEASURED not constant — doubling sizes doubles the estimate', () => {
    const base = { fniBytes: 1e9, regBytes: 2e9, trendBytes: 0.3e9 };
    const dbl = { fniBytes: 2e9, regBytes: 4e9, trendBytes: 0.6e9 };
    const e1 = estimateFinalizationPeakBytes(base);
    assert.equal(estimateFinalizationPeakBytes(dbl), e1 * 2, 'estimate must scale linearly with measured sizes');
    assert.equal(e1, Math.ceil((1e9 + 2e9 + 0.3e9) * FINALIZATION_SAFETY_FACTOR));
    assert.equal(estimateFinalizationPeakBytes({ fniBytes: 0, regBytes: 0, trendBytes: 0 }), 0);
});

test('G3: margin is enforced — free == peak (no margin room) still fails', () => {
    const sizes = { fniBytes: 5e9, regBytes: 5e9, trendBytes: 0 };
    const peak = estimateFinalizationPeakBytes(sizes);
    assert.equal(evaluateDiskGate({ freeBytes: peak, sizes }).ok, false);
    assert.equal(evaluateDiskGate({ freeBytes: peak + FINALIZATION_MARGIN_BYTES, sizes }).ok, true);
});

// ---------- Component 4: bounded trend equivalence ---------------------------

test('T1: TopKHeap selection == legacy stable sort+slice (id order, tie-boundary, 50000)', () => {
    const entities = buildEntities();
    const legacyIds = Object.entries(entities)
        .filter(([, h]) => h && h.length >= 2)
        .sort((a, b) => (b[1][b[1].length - 1]?.score || 0) - (a[1][a[1].length - 1]?.score || 0))
        .slice(0, TREND_TOP_K)
        .map(([id]) => id);
    const heap = new TopKHeap(TREND_TOP_K);
    let idx = 0;
    for (const id of Object.keys(entities)) {
        const h = entities[id];
        const i = idx++;
        if (!h || h.length < 2) continue;
        heap.offer({ id, score: h[h.length - 1]?.score || 0, idx: i });
    }
    const heapIds = heap.drain().slice().sort((a, b) => (b.score - a.score) || (a.idx - b.idx)).map(x => x.id);
    assert.equal(heapIds.length, TREND_TOP_K);
    assert.deepEqual(heapIds, legacyIds);
});

test('T2: >50000 fixture — object/stream write a .zst BYTE-identical to legacy; deterministic', async () => {
    const entities = buildEntities();
    const legacy = legacyTrendData(entities);
    assert.equal(Object.keys(legacy).length, TREND_TOP_K, 'legacy cap holds at 50000');

    // Reference: legacy trendData written via the SAME writer/codec as generateTrendData.
    const outL = await mkTmp('t2l');
    await smartWriteWithVersioning('trend-data.json', legacy, outL, { compress: true });
    const legacyBytes = await readBytes(outL);

    const outO = await mkTmp('t2o');
    await generateTrendData({ entities }, outO);
    const outS = await mkTmp('t2s');
    await generateTrendData(streamOf(entities), outS);
    const outO2 = await mkTmp('t2o2');
    await generateTrendData({ entities }, outO2);

    assert.ok((await readBytes(outO)).equals(legacyBytes), 'object path .zst must byte-equal legacy .zst');
    assert.ok((await readBytes(outS)).equals(legacyBytes), 'stream path .zst must byte-equal legacy .zst');
    assert.ok((await readBytes(outO2)).equals(await readBytes(outO)), 'deterministic across runs');

    for (const d of [outL, outO, outS, outO2]) await fs.rm(d, { recursive: true, force: true });
});

test('T3: small fixture — stream output decompresses to the legacy JSON byte-for-byte', async () => {
    const entities = buildEntities({ unique: 120, tie: 40, filtered: 10, tieScore: 5 }); // <cap; decompress-safe
    const legacy = legacyTrendData(entities);
    const out = await mkTmp('t3');
    await generateTrendData(streamOf(entities), out);
    const json = (await autoDecompress(await readBytes(out))).toString('utf-8');
    assert.equal(json, JSON.stringify(legacy), 'decompressed JSON payload must byte-match legacy');
    assert.deepEqual(Object.keys(JSON.parse(json)), Object.keys(legacy), 'exact key order preserved');
    await fs.rm(out, { recursive: true, force: true });
});

// ---------- Component 5 + 3: FNI streaming reader + fail-loud -----------------

test('S1: streamFniHistoryEntities yields sorted-shard + in-shard key order', async () => {
    const cacheDir = await mkTmp('s1');
    const hDir = path.join(cacheDir, 'fni-history');
    await fs.mkdir(hDir, { recursive: true });
    await fs.writeFile(path.join(hDir, 'part-001.json.zst'),
        await zstdCompress(JSON.stringify({ entities: { 'zeta': [{ score: 1 }], 'alpha': [{ score: 2 }] } })));
    await fs.writeFile(path.join(hDir, 'part-000.json.zst'),
        await zstdCompress(JSON.stringify({ entities: { 'mid': [{ score: 3 }], 'beta': [{ score: 4 }] } })));
    const seen = [];
    await streamFniHistoryEntities((id) => seen.push(id), cacheDir);
    assert.deepEqual(seen, ['mid', 'beta', 'zeta', 'alpha']); // part-000 keys first, then part-001 keys
    await fs.rm(cacheDir, { recursive: true, force: true });
});

test('S2: a corrupt PRESENT shard REJECTS (resource read is fail-loud, not swallowed)', async () => {
    const cacheDir = await mkTmp('s2');
    const hDir = path.join(cacheDir, 'fni-history');
    await fs.mkdir(hDir, { recursive: true });
    await fs.writeFile(path.join(hDir, 'part-000.json'), 'not-valid-json{{{'); // present + unreadable
    await assert.rejects(
        () => streamFniHistoryEntities(() => {}, cacheDir),
        'a corrupt shard must throw, never be silently swallowed',
    );
    await fs.rm(cacheDir, { recursive: true, force: true });
});

test('S3: a MISSING history dir is the only non-fatal cold-start case (empty, no throw)', async () => {
    const cacheDir = await mkTmp('s3'); // no fni-history/ subdir
    const seen = [];
    await streamFniHistoryEntities((id) => seen.push(id), cacheDir);
    assert.deepEqual(seen, []);
    await fs.rm(cacheDir, { recursive: true, force: true });
});
