// FINDING-GR-1 / D-2026-0809-416 SS1 (a): producer-side EMITTED-LINE ASSERTION,
// typed QUARANTINE, and the contract table as the SOLE input.
//
// HERMETIC: oversized lines are synthesised from a repeated filler character.
// No real record content, no network, no credentials, no R2, no workflow.
//
// NON-VACUITY: T1/T2 go red if the assertion is deleted or downgraded to a skip;
// T4/T5/T6 go red if the quarantine stops counting/disclosing or starts writing
// the payload; T8 goes red if any bound is re-introduced outside the table; T9
// goes red if the 64 MiB consumer ceiling is touched or the headroom is spent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    assertEmittedLineBytes, screenRecordBytes, emitNormalizedRecord, quarantineRecord, resolveBounds,
    producerBoundSummary, writeQuarantineManifest, ProducerLineBoundError,
    PRODUCER_LINE_TERMINAL,
} from './lib/producer-emitter.js';
import { createCounters } from './lib/field-contract-enforcer.js';
import {
    PRODUCER_LINE_MAX_BYTES, CONSUMER_RECORD_CEILING_BYTES, QUARANTINE_REASON,
    LINE_TERMINATOR_BYTES, QUARANTINE_MANIFEST_MAX_ENTRIES,
} from './lib/field-contracts.js';
import { MAX_RECORD_BYTES } from '../factory/lib/ndjson-byte-reader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Writable-stream double that records every chunk and never blocks. */
function fakeStream(acceptWrites = true) {
    const chunks = [];
    return {
        chunks,
        write(chunk) { chunks.push(chunk); return acceptWrites; },
        once(event, cb) { if (event === 'drain') setImmediate(cb); },
    };
}

test('T1 assertion: an over-bound line throws a NAMED typed error, never a skip', () => {
    const line = `${'x'.repeat(PRODUCER_LINE_MAX_BYTES)}\n`;
    let thrown = null;
    try { assertEmittedLineBytes(line, { source: 'kaggle', id: 'synthetic-id' }); }
    catch (e) { thrown = e; }

    assert.ok(thrown instanceof ProducerLineBoundError, 'must throw ProducerLineBoundError');
    assert.equal(thrown.code, PRODUCER_LINE_TERMINAL);
    assert.equal(thrown.code, 'PRODUCER_LINE_BYTES_LIMIT_EXCEEDED');
    assert.equal(thrown.lineBytes, PRODUCER_LINE_MAX_BYTES + LINE_TERMINATOR_BYTES);
    assert.equal(thrown.maxBytes, PRODUCER_LINE_MAX_BYTES);
    assert.equal(thrown.source, 'kaggle');
    assert.equal(thrown.id, 'synthetic-id');
});

test('T2 assertion boundary: exactly the bound passes, one byte over throws', () => {
    const atBound = 'y'.repeat(PRODUCER_LINE_MAX_BYTES);
    assert.equal(assertEmittedLineBytes(atBound), PRODUCER_LINE_MAX_BYTES);
    assert.throws(() => assertEmittedLineBytes(`${atBound}y`), { code: PRODUCER_LINE_TERMINAL });
});

test('T3 assertion honours an injected bound (no hidden constant inside)', () => {
    assert.equal(assertEmittedLineBytes('abcd', {}, 4), 4);
    assert.throws(() => assertEmittedLineBytes('abcde', {}, 4), { code: PRODUCER_LINE_TERMINAL });
});

test('T4 screen: the line terminator counts toward the bound', () => {
    assert.equal(screenRecordBytes(PRODUCER_LINE_MAX_BYTES - LINE_TERMINATOR_BYTES), null);
    assert.equal(screenRecordBytes(PRODUCER_LINE_MAX_BYTES),
        QUARANTINE_REASON.RECORD_BYTES_OVER_PRODUCER_BOUND);
});

test('T5 quarantine: over-bound record is NOT emitted, IS counted, IS disclosed', async () => {
    const state = createCounters();
    const stream = fakeStream();
    const record = {
        id: 'kaggle-dataset--synthetic--giant', source: 'kaggle', type: 'dataset',
        body_content: 'z'.repeat(PRODUCER_LINE_MAX_BYTES),
    };

    const out = await emitNormalizedRecord(record, stream, state);

    assert.equal(out.emitted, false);
    assert.equal(out.disposition, 'quarantine');
    assert.equal(stream.chunks.length, 0, 'a quarantined record must never reach the stream');
    assert.equal(state.records_quarantined, 1);
    assert.equal(state.quarantine.length, 1);
    assert.deepEqual(
        { ...state.quarantine[0], measured_bytes: undefined },
        {
            id: 'kaggle-dataset--synthetic--giant', source: 'kaggle', type: 'dataset',
            reason: QUARANTINE_REASON.RECORD_BYTES_OVER_PRODUCER_BOUND, measured_bytes: undefined,
        },
    );
    assert.ok(state.quarantine[0].measured_bytes > PRODUCER_LINE_MAX_BYTES);
});

test('T6 emit: a conforming record is written once, terminated, and counted', async () => {
    const state = createCounters();
    const stream = fakeStream();
    const record = { id: 'ok', source: 'kaggle', type: 'dataset', tags: ['nlp'] };

    const out = await emitNormalizedRecord(record, stream, state);

    assert.equal(out.emitted, true);
    assert.deepEqual(stream.chunks, [`${JSON.stringify(record)}\n`]);
    assert.equal(state.records_quarantined, 0);
});

test('T7 backpressure: a full stream is awaited, not bypassed', async () => {
    const state = createCounters();
    const stream = fakeStream(false);
    const out = await emitNormalizedRecord({ id: 'bp', source: 'kaggle', type: 'dataset' }, stream, state);

    assert.equal(out.emitted, true);
    assert.equal(stream.chunks.length, 1);
});

test('T8 quarantine manifest: identity + reason only, payload NEVER written', () => {
    const state = createCounters();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grq-'));
    quarantineRecord(
        { id: 'q1', source: 'kaggle', type: 'dataset', body_content: 'SECRET-PAYLOAD-MARKER' },
        999, QUARANTINE_REASON.RECORD_BYTES_OVER_PRODUCER_BOUND, state,
    );

    const file = writeQuarantineManifest('kaggle', state, dir);
    const text = fs.readFileSync(file, 'utf8');
    const doc = JSON.parse(text);

    assert.equal(doc.quarantined, 1);
    assert.equal(doc.identities_recorded, 1);
    assert.equal(doc.identities_cap, QUARANTINE_MANIFEST_MAX_ENTRIES);
    assert.equal(doc.records[0].id, 'q1');
    assert.equal(text.includes('SECRET-PAYLOAD-MARKER'), false, 'payload must never be persisted');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('T9 counters summary publishes exactly what happened', () => {
    const state = createCounters();
    state.records_contract_examined = 7;
    state.elements_dropped = 3;
    const summary = producerBoundSummary(state);

    assert.equal(summary.records_contract_examined, 7);
    assert.equal(summary.elements_dropped, 3);
    assert.equal(summary.records_quarantined, 0);
    assert.equal(summary.producer_line_max_bytes, PRODUCER_LINE_MAX_BYTES);
});

test('T10 the 64 MiB consumer ceiling is untouched and the headroom is documented', () => {
    assert.equal(MAX_RECORD_BYTES, 64 * 1024 * 1024, 'the 2/4 consumer ceiling MUST NOT change');
    assert.equal(CONSUMER_RECORD_CEILING_BYTES, MAX_RECORD_BYTES,
        'the table must reproduce the consumer ceiling exactly, or the derivation is fiction');
    assert.ok(PRODUCER_LINE_MAX_BYTES < CONSUMER_RECORD_CEILING_BYTES);
    assert.equal(CONSUMER_RECORD_CEILING_BYTES / PRODUCER_LINE_MAX_BYTES, 2,
        'documented headroom is 2x; changing it must be a deliberate, reviewed act');
});

test('T12 the REAL emit path asserts: screen intact, record passes it, assertion fires', async () => {
    // REQUIRED-F1(ii). The screen threshold is set ABOVE the record so the record
    // legitimately clears it; the line bound is set BELOW. The only thing that can
    // stop this record is the assertion INSIDE emitNormalizedRecord, so deleting
    // that call turns this test red.
    const state = createCounters();
    const stream = fakeStream();
    const record = { id: 'assert-me', source: 'kaggle', type: 'dataset', tags: ['nlp', 'vision'] };
    const recordBytes = Buffer.byteLength(JSON.stringify(record), 'utf8');

    await assert.rejects(
        () => emitNormalizedRecord(record, stream, state, {
            screenMaxBytes: recordBytes * 2, lineMaxBytes: recordBytes - 1,
        }),
        (e) => e instanceof ProducerLineBoundError && e.code === PRODUCER_LINE_TERMINAL,
    );
    assert.equal(stream.chunks.length, 0, 'nothing may be written once the assertion fires');
    assert.equal(state.records_quarantined, 0, 'this is an assertion breach, NOT a quarantine');
});

test('T13 injected bounds resolve to the TABLE VALUE when absent (D4)', async () => {
    // Pin the VALUE, not merely the behaviour: "a small record still emits" would
    // pass unchanged if the default silently became 1 GiB.
    assert.equal(resolveBounds().lineMaxBytes, PRODUCER_LINE_MAX_BYTES);
    assert.equal(resolveBounds().screenMaxBytes, PRODUCER_LINE_MAX_BYTES);
    assert.equal(resolveBounds({}).lineMaxBytes, PRODUCER_LINE_MAX_BYTES);
    assert.equal(resolveBounds({}).screenMaxBytes, PRODUCER_LINE_MAX_BYTES);
    // A partial override must not silently relax the bound that was NOT overridden.
    assert.equal(resolveBounds({ lineMaxBytes: 4 }).screenMaxBytes, 4);
    assert.equal(resolveBounds({ screenMaxBytes: 4 }).lineMaxBytes, PRODUCER_LINE_MAX_BYTES);

    // ...and the emitter uses exactly that resolution.
    const state = createCounters();
    const stream = fakeStream();
    const record = { id: 'default-bounds', source: 'kaggle', type: 'dataset' };
    const out = await emitNormalizedRecord(record, stream, state);
    const outExplicit = await emitNormalizedRecord(record, stream, state, {});
    assert.equal(out.emitted, true);
    assert.equal(outExplicit.emitted, true);
    assert.equal(stream.chunks.length, 2);
    assert.equal(state.producer_line_breach, null, 'a clean emit must not record a breach');
});

test('T11 SOLE INPUT: no bound literal survives outside the contract table', () => {
    // Every enforcement module must obtain its numbers from field-contracts.js.
    // A magic number in an enforcement module is a bound nobody can audit.
    const BOUND_LITERALS = ['33554432', '67108864', '8192', '1024 * 1024', '* MiB'];
    for (const rel of ['lib/field-contract-enforcer.js', 'lib/producer-emitter.js']) {
        const src = fs.readFileSync(path.join(HERE, rel), 'utf8');
        for (const lit of BOUND_LITERALS) {
            assert.equal(src.includes(lit), false, `${rel} must not contain the bound literal "${lit}"`);
        }
        // Allowed literals: 0/1 (counter arithmetic) and 2 (the two JSON quote
        // characters around a string element -- a serialisation fact, not a bound).
        const numbers = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
            .match(/(?<![\w.$])\d+(?![\w.$])/g) || [];
        for (const n of numbers) {
            assert.ok(['0', '1', '2'].includes(n), `${rel} contains unexplained numeric literal ${n}`);
        }
        assert.ok(src.includes("from './field-contracts.js'"), `${rel} must import the table`);
    }
});
