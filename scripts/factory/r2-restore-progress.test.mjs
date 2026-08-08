// T3 (D-2026-0808-405): restore progress heartbeat.
// Hermetic - injected clock/timer/sink. ZERO real network, credentials or R2.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    createRestoreProgress, HEARTBEAT_INTERVAL_MS, PROGRESS_MARKER, PROGRESS_SCHEMA,
} from './lib/r2-restore-progress.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Controllable clock + interval so "30 seconds" is deterministic, not slept. */
function harness({ expected = 10, concurrency = 5, intervalMs = HEARTBEAT_INTERVAL_MS } = {}) {
    const lines = [];
    let t = 1_000_000;
    let cb = null;
    let cleared = 0;
    const p = createRestoreProgress({
        expected, concurrency, intervalMs,
        now: () => t,
        emit: (l) => lines.push(l),
        setTimer: (fn) => { cb = fn; return { id: 1, unref() { this.unrefed = true; } }; },
        clearTimer: () => { cleared += 1; cb = null; },
    });
    return {
        p, lines,
        tick(ms = intervalMs) { t += ms; if (cb) cb(); },
        advance(ms) { t += ms; },
        get cleared() { return cleared; },
        get timerLive() { return cb !== null; },
        recs: () => lines.map((l) => JSON.parse(l.slice(PROGRESS_MARKER.length + 1))),
    };
}

test('T3 heartbeat reports every required field', () => {
    const h = harness({ expected: 7, concurrency: 5 });
    h.p.onRestored(2048);
    h.tick();
    const r = h.recs()[0];
    for (const k of ['schema', 'phase', 'elapsed_s', 'processed', 'restored', 'failed', 'expected', 'restored_bytes', 'concurrency']) {
        assert.ok(k in r, `heartbeat must report ${k}`);
    }
    assert.equal(r.schema, PROGRESS_SCHEMA);
    assert.equal(r.expected, 7);
    assert.equal(r.concurrency, 5);
    assert.equal(r.restored_bytes, 2048);
    assert.equal(r.elapsed_s, 30);
});

test('T3 the production interval is <= 30 seconds', () => {
    assert.ok(HEARTBEAT_INTERVAL_MS <= 30000, 'heartbeat must fire at least every 30s');
});

test('T3 a SLOW restore emits MULTIPLE heartbeats before completing', () => {
    const h = harness({ expected: 4 });
    h.p.onRestored(10); h.tick();
    h.p.onRestored(10); h.tick();
    h.p.onRestored(10); h.tick();
    assert.equal(h.recs().length, 3, 'three in-progress heartbeats');
    assert.deepEqual(h.recs().map((r) => r.phase), ['in_progress', 'in_progress', 'in_progress']);
    assert.deepEqual(h.recs().map((r) => r.restored), [1, 2, 3]);
    h.p.onRestored(10);
    h.p.stop();
    const all = h.recs();
    assert.equal(all.length, 4);
    assert.equal(all[3].phase, 'complete');
    assert.equal(all[3].restored, 4);
});

test('T3 a STUCK batch still emits heartbeats, with UNCHANGED counters', () => {
    const h = harness({ expected: 9 });
    h.p.onRestored(500);
    h.p.onRestored(500);          // two done, then the batch wedges
    h.tick(); h.tick(); h.tick(); // wall-clock keeps advancing
    const r = h.recs();
    assert.equal(r.length, 3, 'a wedged batch must still produce records');
    assert.deepEqual(r.map((x) => x.processed), [2, 2, 2], 'counters do NOT advance');
    assert.deepEqual(r.map((x) => x.restored), [2, 2, 2]);
    assert.deepEqual(r.map((x) => x.restored_bytes), [1000, 1000, 1000]);
    assert.deepEqual(r.map((x) => x.elapsed_s), [30, 60, 90], 'elapsed DOES advance - that is the hang signal');
    assert.ok(r.every((x) => x.expected === 9));
});

test('T3 all four exit paths emit a terminal record and clear the timer', () => {
    // (1) clean success
    let h = harness({ expected: 1 });
    h.p.onRestored(1); h.p.stop('complete');
    assert.equal(h.cleared, 1); assert.equal(h.timerLive, false);
    assert.equal(h.recs().at(-1).phase, 'complete');

    // (2) missing member (restored < expected)
    h = harness({ expected: 3 });
    h.p.onRestored(1); h.p.stop('complete');
    const missing = h.recs().at(-1);
    assert.equal(h.cleared, 1);
    assert.ok(missing.restored < missing.expected, 'shortfall is visible in the terminal record');

    // (3) failed member
    h = harness({ expected: 2 });
    h.p.onRestored(1); h.p.onFailed(); h.p.stop('complete_with_failures');
    assert.equal(h.cleared, 1);
    assert.equal(h.recs().at(-1).phase, 'complete_with_failures');
    assert.equal(h.recs().at(-1).failed, 1);

    // (4) thrown error -> the caller's finally still stops it
    h = harness({ expected: 5 });
    try { h.p.onRestored(1); throw new Error('boom'); }
    catch { /* swallowed by the test, as the caller's finally would */ }
    finally { h.p.stop('complete'); }
    assert.equal(h.cleared, 1, 'timer cleared on the throw path');
    assert.equal(h.timerLive, false);
});

test('T3 stop() is idempotent and no heartbeat survives it', () => {
    const h = harness({ expected: 2 });
    h.p.stop('complete');
    h.p.stop('complete');
    h.p.stop('complete_with_failures');
    assert.equal(h.cleared, 1, 'timer cleared exactly once');
    assert.equal(h.recs().length, 1, 'exactly one terminal record');
    h.tick();
    assert.equal(h.recs().length, 1, 'no heartbeat after stop');
    assert.equal(h.p.stopped, true);
    assert.equal(h.p.timerActive, false);
});

test('T3 the real timer is unref-ed so telemetry can never hold the process open', () => {
    let captured = null;
    const p = createRestoreProgress({
        expected: 1, concurrency: 1,
        emit: () => {},
        setTimer: () => { captured = { unref() { captured.unrefed = true; } }; return captured; },
        clearTimer: () => {},
    });
    assert.equal(captured.unrefed, true, 'unref() must be called on the interval handle');
    p.stop();
});

test('T3 hostile keys, error text and credential-shaped tokens NEVER enter telemetry', () => {
    const POISON = [
        'state/_handoff/secret/shard-7.json.zst',
        'AKIAIOSFODNN7EXAMPLE',
        'https://bucket.r2.cloudflarestorage.com/x?X-Amz-Signature=deadbeef',
        'AccessDenied: token has no writable scopes',
        '{"body":"object payload"}',
    ];
    const h = harness({ expected: 3 });
    // Feed poison through every argument the API accepts.
    h.p.onRestored(POISON[0]);        // non-numeric size
    h.p.onRestored({ toString: () => POISON[1] });
    h.p.onFailed(POISON[2], POISON[3], POISON[4]); // extra args are ignored by design
    h.tick();
    h.p.stop('complete');
    const blob = h.lines.join('\n');
    for (const s of POISON) assert.equal(blob.includes(s), false, `telemetry leaked: ${s.slice(0, 40)}`);
    // And the non-numeric sizes contributed ZERO bytes rather than NaN/"undefined".
    const last = h.recs().at(-1);
    assert.equal(last.restored_bytes, 0);
    assert.equal(Number.isFinite(last.restored_bytes), true);
    assert.equal(h.lines.every((l) => l.startsWith(PROGRESS_MARKER)), true);
});

test('T3 onFailed takes no error argument (no leak surface by construction)', () => {
    const src = fs.readFileSync(path.join(HERE, 'lib', 'r2-restore-progress.js'), 'utf8');
    assert.match(src, /onFailed\(\)\s*\{/, 'onFailed must be zero-arity');
    // The emitter may only ever see the fixed numeric snapshot.
    assert.match(src, /JSON\.stringify\(snapshot\(phase\)\)/);
});
