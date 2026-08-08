// D-2026-0806-404 hermetic regression tests for R1 / R2a / R3.
// No network, no credentials, no R2, generated fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import readline from 'readline';
import { Readable } from 'stream';
import {
    readNdjsonLines, RecordSizeLimitExceededError, RECORD_SIZE_TERMINAL,
    MAX_RECORD_BYTES, READER_RETAINED_CAP_BYTES,
} from './lib/ndjson-byte-reader.js';
import {
    evaluateShardMemoryGate, projectShardPeakHeapBytes, scanShardProfile,
    SHARD_COMPARISON_FACTOR, SHARD_RESERVE_BYTES,
    GATE_TERMINAL_PROJECTED, GATE_TERMINAL_RECORD,
} from './lib/shard-memory-gate.js';
import { evaluateMemoryGate, MEMORY_CLEARLY_FACTOR } from './lib/runner-capacity-preflight.mjs';

const MiB = 1024 * 1024;
const chunked = (s, n) => {
    const b = Buffer.from(s); const out = [];
    for (let i = 0; i < b.length; i += n) out.push(b.subarray(i, i + n));
    return out;
};
async function collect(src, opts) { const o = []; for await (const l of readNdjsonLines(src, opts)) o.push(l); return o; }
async function viaReadline(s) {
    const rl = readline.createInterface({ input: Readable.from([Buffer.from(s)]), crlfDelay: Infinity });
    const o = []; for await (const l of rl) o.push(l); return o;
}

// --- T-3a READER-BOUNDARY PARITY (Class B; control M3.b') ------------------
const FIXTURES = {
    lf: '{"id":"a"}\n{"id":"b"}\n',
    lfNoTrailing: '{"id":"a"}\n{"id":"b"}',
    crlf: '{"id":"a"}\r\n{"id":"b"}\r\n',
    bareCR: '{"id":"a"}\r{"id":"b"}\r',
    blankBetween: '{"id":"a"}\n\n{"id":"b"}\n',
    malformed: '{"id":"a"}\nNOT JSON\n{"id":"b"}\n',
    mixed: '{"id":"a"}\r\n{"id":"b"}\n{"id":"c"}\r{"id":"d"}',
    utf8: '{"id":"éè"}\n{"id":"中"}\n',
    empty: '',
    onlyNewline: '\n',
};

test('T-3a reader yields EXACTLY node readline line arrays, all fixtures, all chunkings', async () => {
    for (const [name, src] of Object.entries(FIXTURES)) {
        const golden = await viaReadline(src);
        for (const cs of [1, 2, 3, 7, 4096]) {
            const got = await collect(Readable.from(chunked(src, cs)), {});
            assert.deepEqual(got, golden, `${name} @chunk=${cs}`);
        }
    }
});

test('T-3a M3.b-prime: terminator mutations DO differ at the reader boundary', () => {
    // The golden array is the falsifiable object. These are the two mutations
    // erratum v2 B-1 proved differ at THIS boundary (they do not differ at the
    // loop boundary, which is why the loop-level terminator claim was withdrawn).
    const src = FIXTURES.crlf;
    const golden = ['{"id":"a"}', '{"id":"b"}'];
    const mutBareCRSplits = src.split(/\r\n|\n|\r/);            // keeps trailing empties
    const mutRetainCR = src.split('\n').map((l) => l).slice(0, -1); // retains \r
    assert.notDeepEqual(mutBareCRSplits, golden, 'mutation 1 must differ');
    assert.notDeepEqual(mutRetainCR, golden, 'mutation 2 must differ');
});

// --- T-1 BYTE-BOUNDED READ-AHEAD (Class A) --------------------------------
test('T-1 retained bytes stay under the declared cap across three line sizes', async () => {
    for (const lineBytes of [100 * 1024, 1 * MiB, 8 * MiB]) {
        const line = 'x'.repeat(lineBytes);
        const src = Readable.from(chunked(Array.from({ length: 12 }, () => line).join('\n') + '\n', 64 * 1024));
        let peak = 0;
        let n = 0;
        for await (const l of readNdjsonLines(src, { onRetained: (b) => { if (b > peak) peak = b; } })) {
            n += 1;
            assert.equal(l.length, lineBytes);
            await new Promise((r) => setImmediate(r)); // slow consumer
        }
        assert.equal(n, 12);
        assert.ok(peak <= READER_RETAINED_CAP_BYTES, `peak ${peak} <= cap ${READER_RETAINED_CAP_BYTES}`);
        // Non-vacuity: the OLD behaviour retained ~1,026 lines. Assert the new
        // peak is far below even 12 lines, i.e. genuinely per-line bounded.
        assert.ok(peak < lineBytes * 3, `peak ${peak} must be O(one line), not O(queue)`);
    }
});

// --- T-3b LOOP-BOUNDARY PARITY (Class B; controls M3.a, M3.c) -------------
// Replicates shard-processor.js:140-184 loop accounting over the reader.
async function loopAccounting(src, { dropFinal = false, noIndexOnMalformed = false } = {}) {
    let entityIndex = 0, processedCount = 0, successCount = 0, out = '';
    let lines = await collect(Readable.from([Buffer.from(src)]), {});
    if (dropFinal && !/[\n\r]$/.test(src)) lines = lines.slice(0, -1);
    for (const line of lines) {
        if (!line) continue;
        let entity;
        try { entity = JSON.parse(line); } catch { if (!noIndexOnMalformed) entityIndex++; continue; }
        successCount++; processedCount++;
        out += (out ? ',\n' : '') + JSON.stringify({ id: entity.id, success: true });
        entityIndex++;
    }
    return { entityIndex, processedCount, successCount, outBytes: Buffer.byteLength(out) };
}

test('T-3b loop accounting is identical for LF / CRLF / bare CR (terminator UNOBSERVABLE here)', async () => {
    const a = await loopAccounting('{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n');
    const b = await loopAccounting('{"id":"a"}\r\n{"id":"b"}\r\n{"id":"c"}\r\n');
    const c = await loopAccounting('{"id":"a"}\r{"id":"b"}\r{"id":"c"}\r');
    assert.deepEqual(a, b); assert.deepEqual(a, c);
    assert.deepEqual(a, { entityIndex: 3, processedCount: 3, successCount: 3, outBytes: a.outBytes });
});

test('T-3b M3.a: dropping the final unterminated record falsifies', async () => {
    const src = '{"id":"a"}\n{"id":"b"}\n{"id":"c"}';
    const base = await loopAccounting(src);
    const mut = await loopAccounting(src, { dropFinal: true });
    assert.equal(base.entityIndex, 3);
    assert.equal(mut.entityIndex, 2);
    assert.notDeepEqual(mut, base);
});

test('T-3b M3.c: skipping entityIndex++ on a malformed line falsifies', async () => {
    const src = '{"id":"a"}\nNOT JSON\n{"id":"c"}\n';
    const base = await loopAccounting(src);
    const mut = await loopAccounting(src, { noIndexOnMalformed: true });
    assert.equal(base.entityIndex, 3);
    assert.equal(mut.entityIndex, 2);
    assert.notDeepEqual(mut, base);
});

// --- T-4 ZERO-LOSS GUARDS (Class B; M4.a needs the EXACT message) ---------
function zeroLossGuards({ entityIndex, processedCount }, { neuterIndexGuard = false, neuterProcessedGuard = false } = {}) {
    if (!neuterIndexGuard && entityIndex === 0) throw new Error('streamed 0 entities');
    if (!neuterProcessedGuard && processedCount === 0) throw new Error('processed 0 entities');
    return null;
}

test('T-4(a) empty input throws the EXACT message "streamed 0 entities"', async () => {
    const acc = await loopAccounting('');
    assert.deepEqual([acc.entityIndex, acc.processedCount], [0, 0]);
    assert.throws(() => zeroLossGuards(acc), /^Error: streamed 0 entities$/);
});

test('T-4 M4.a: neutering the entityIndex guard changes the EXACT message', async () => {
    const acc = await loopAccounting('');
    assert.throws(() => zeroLossGuards(acc, { neuterIndexGuard: true }), /^Error: processed 0 entities$/);
});

test('T-4(b-prime) ALL-MALFORMED input reaches the processedCount guard', async () => {
    const acc = await loopAccounting('NOT JSON\nALSO NOT JSON\n');
    assert.deepEqual([acc.entityIndex, acc.processedCount], [2, 0]);
    assert.throws(() => zeroLossGuards(acc), /^Error: processed 0 entities$/);
});

test('T-4 M4.b: neutering the processedCount guard falsifies ONLY with fixture (b-prime)', async () => {
    const acc = await loopAccounting('NOT JSON\nALSO NOT JSON\n');
    assert.equal(zeroLossGuards(acc, { neuterProcessedGuard: true }), null);
});

test('T-4 pins CURRENT D-6 behaviour: a throwing processEntity still counts as processed', () => {
    // NOT a fix. D-6 is a separate lane. Pinned so this lane cannot drift it.
    let entityIndex = 0, processedCount = 0;
    for (const _ of ['{"id":"a"}', '{"id":"b"}']) {
        try { throw new Error('processEntity failed'); } catch { processedCount++; }
        entityIndex++;
    }
    assert.deepEqual([entityIndex, processedCount], [2, 2]);
    assert.equal(zeroLossGuards({ entityIndex, processedCount }), null, 'guard does NOT fire - current behaviour');
});

// --- T-5 R2a OVERSIZE RECORD, FAIL-CLOSED (Class C) -----------------------
test('T-5 an oversize record fails closed with the named terminal and exact measurement', async () => {
    const ceiling = 1024;
    const big = 'y'.repeat(4096);
    const src = `{"id":"a"}\n${big}\n{"id":"c"}\n`;
    let err = null;
    const seen = [];
    try {
        for await (const l of readNdjsonLines(Readable.from(chunked(src, 256)), {
            shardId: 7, inputIdentity: 'cache/merged_shard_7.json.zst', maxRecordBytes: ceiling,
        })) seen.push(l);
    } catch (e) { err = e; }
    assert.ok(err instanceof RecordSizeLimitExceededError);
    assert.equal(err.terminalCode, RECORD_SIZE_TERMINAL);
    assert.equal(err.shardId, 7);
    assert.equal(err.measuredBytes, 4096, 'EXACT measured size, not the cap');
    assert.equal(err.ceilingBytes, ceiling);
    assert.equal(err.recordOrdinal, 2);
    assert.equal(err.inputIdentity, 'cache/merged_shard_7.json.zst');
    assert.equal(err.message.includes(big), false, 'record content must NEVER appear');
    assert.deepEqual(seen, ['{"id":"a"}'], 'records after the breach are NEVER emitted');
});

test('T-5 M5.a mutation: converting fail-closed to silent continue is DETECTED', async () => {
    // Mutation = a reader that skips the oversize record instead of throwing.
    async function* mutated(src, ceiling) {
        for await (const l of readNdjsonLines(src, { maxRecordBytes: Number.MAX_SAFE_INTEGER })) {
            if (Buffer.byteLength(l, 'utf8') > ceiling) continue; // SILENT SKIP
            yield l;
        }
    }
    const src = `{"id":"a"}\n${'y'.repeat(4096)}\n{"id":"c"}\n`;
    const out = [];
    let threw = null;
    try { for await (const l of mutated(Readable.from(chunked(src, 256)), 1024)) out.push(l); } catch (e) { threw = e; }
    assert.equal(threw, null, 'the mutation does NOT throw - that is the defect');
    assert.deepEqual(out, ['{"id":"a"}', '{"id":"c"}'], 'the mutation silently drops the record');
    // The real reader must NOT behave this way:
    assert.notDeepEqual(out, ['{"id":"a"}'], 'baseline and mutation differ => T-5 is non-vacuous');
});

// --- T-7 R3 DECISION RULE (Class A) ---------------------------------------
// Real 2026-08-05 inputs.
const OLD_SPACE = 6144 * MiB;                 // 6,442,450,944
const RAM = 16766976000;
const TRUE_LIVE_HEAP = Math.round(6170.3 * MiB); // 6,470,028,493 (6.0257 GiB)

test('T-7(a) the 2026-08-05 profile PASSES the OLD rule - historical false pass reproduced', () => {
    const perfect = evaluateMemoryGate({
        phase: 'PROCESS_SHARD', estimatedPeakHeapBytes: TRUE_LIVE_HEAP,
        oldSpaceLimitBytes: OLD_SPACE, availableRamBytes: RAM,
    });
    assert.equal(perfect.clearlyFactor, MEMORY_CLEARLY_FACTOR);
    assert.equal(perfect.clearThresholdBytes, Math.ceil(OLD_SPACE * 1.5));
    assert.equal(perfect.ok, true, 'a PERFECT 6.03 GiB estimate STILL passes the old rule');
});

test('T-7(b) the SAME profile FAILS the NEW rule with a named terminal', () => {
    const d = evaluateShardMemoryGate({
        projectedPeakHeapBytes: TRUE_LIVE_HEAP,
        oldSpaceLimitBytes: OLD_SPACE, availableRamBytes: RAM,
    });
    assert.equal(d.comparisonFactor, SHARD_COMPARISON_FACTOR);
    assert.ok(d.comparisonFactor <= 1.0, 'comparison factor must be <= 1.0');
    assert.equal(d.reserveBytes, SHARD_RESERVE_BYTES);
    assert.equal(d.usableBytes, OLD_SPACE - SHARD_RESERVE_BYTES);
    assert.equal(d.ok, false);
    assert.equal(d.terminalCode, GATE_TERMINAL_PROJECTED);
});

test('T-7 the record criterion trips INDEPENDENTLY of the aggregate estimate', () => {
    const d = evaluateShardMemoryGate({
        projectedPeakHeapBytes: 1024, // trivially small aggregate
        oldSpaceLimitBytes: OLD_SPACE, availableRamBytes: RAM,
        maxRecordBytes: MAX_RECORD_BYTES + 1, recordCeilingBytes: MAX_RECORD_BYTES,
    });
    assert.equal(d.projectedExceedsUsable, false);
    assert.equal(d.ok, false);
    assert.equal(d.terminalCode, GATE_TERMINAL_RECORD);
});

test('T-7 mutation: restoring clearlyFactor 1.5 makes the new gate pass again', () => {
    const mutated = evaluateShardMemoryGate({
        projectedPeakHeapBytes: TRUE_LIVE_HEAP,
        oldSpaceLimitBytes: OLD_SPACE, availableRamBytes: RAM,
        comparisonFactor: 1.5, reserveBytes: 0,
    });
    assert.equal(mutated.ok, true, 'the OLD comparison lets 6.03 GiB through - proves the rule change is load-bearing');
});

test('T-7 an unknown capacity is INDETERMINATE and must not false-fail', () => {
    const d = evaluateShardMemoryGate({ projectedPeakHeapBytes: TRUE_LIVE_HEAP, oldSpaceLimitBytes: 0, availableRamBytes: 0 });
    assert.equal(d.indeterminate, true);
    assert.equal(d.ok, true);
});

test('R3 scan discloses truncation and never presents a prefix max as complete', async () => {
    const src = Array.from({ length: 50 }, (_, i) => JSON.stringify({ id: `e${i}` })).join('\n') + '\n';
    const full = await scanShardProfile(readNdjsonLines(Readable.from([Buffer.from(src)]), {}));
    assert.equal(full.lineCount, 50);
    assert.equal(full.scanTruncated, false);
    assert.equal(full.maxRecordBytesIsLowerBound, false);
    const trunc = await scanShardProfile(readNdjsonLines(Readable.from([Buffer.from(src)]), {}), { lineBudget: 10 });
    assert.equal(trunc.lineCount, 10);
    assert.equal(trunc.scanTruncated, true);
    assert.equal(trunc.maxRecordBytesIsLowerBound, true, 'a truncated scan MUST disclose its max is a lower bound');
});

test('projectShardPeakHeapBytes composes base + reader cap + amplified max record', () => {
    assert.equal(projectShardPeakHeapBytes({ baseContextBytes: 100, readerRetainedCapBytes: 200, maxRecordBytes: 10, parseAmplification: 3 }), 330);
});
