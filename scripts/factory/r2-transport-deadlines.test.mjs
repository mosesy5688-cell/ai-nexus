// REST-1b (D-2026-0816-438): transport deadlines. A wedged member must become a
// THROWN, CLASSIFIED, RETRYABLE error instead of an unbounded hang.
// Hermetic - injected timers and hand-built async iterables. No network/R2.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    R2_CONNECTION_TIMEOUT_MS, R2_STREAM_IDLE_TIMEOUT_MS,
    r2RequestHandlerConfig, readBodyWithIdleDeadline, createStreamIdleError,
} from './lib/r2-transport-deadlines.js';
import { classifyR2Error } from './lib/r2-handoff.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A body that yields `chunks` and then HANGS forever - the 08-16 wedge. */
function wedgedBody(chunks = [Buffer.from('a')]) {
    let destroyed = false;
    return {
        get destroyed() { return destroyed; },
        destroy() { destroyed = true; },
        async *[Symbol.asyncIterator]() {
            for (const c of chunks) yield c;
            await new Promise(() => { /* never resolves */ });
        },
    };
}

function healthyBody(chunks) {
    return { async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } };
}

// --- derivation ------------------------------------------------------------

test('REST-1b the deadlines are the documented 08-15 derivation', () => {
    assert.equal(R2_CONNECTION_TIMEOUT_MS, 10000);
    assert.equal(R2_STREAM_IDLE_TIMEOUT_MS, 60000);
    // 08-15 healthy precedent: 1185628322 B / 68 s over concurrency 5.
    const perStream = (1185628322 / 68) / 5;
    const largestObjectSeconds = 7 * 1024 * 1024 / perStream;
    assert.ok(largestObjectSeconds < 3, `largest object ~${largestObjectSeconds.toFixed(1)}s at healthy rate`);
    // The idle budget must be a large multiple of a whole large-object transfer.
    assert.ok(R2_STREAM_IDLE_TIMEOUT_MS / 1000 > largestObjectSeconds * 20,
        'idle budget must leave generous margin over the healthy precedent');
});

test('REST-1b NO requestTimeout on the shared read/write client (D-441 ruling)', () => {
    const cfg = r2RequestHandlerConfig();
    assert.equal(cfg.connectionTimeout, R2_CONNECTION_TIMEOUT_MS);
    // D-2026-0816-441 SS1 RULES requestTimeout out of this PR; this pin keeps the
    // ruling enforced. createR2Client is shared with the PUT path, requestTimeout
    // only clears when response HEADERS arrive, and a single-shot PutObjectCommand
    // gets its headers only after the WHOLE body is transmitted -- so any request
    // deadline is a total-transfer cap on every upload. Healthy write precedent:
    // 19682.1 MB / 295.6 s over concurrency 5 => 182.2 MB mean ~= 13.7 s per PUT.
    assert.equal('requestTimeout' in cfg, false, 'no undeclared cap on writes');
    assert.equal('throwOnRequestTimeout' in cfg, false, 'removed with it per D-441');
    // Connection-phase only: for a GET, headers arrive inside the connect window.
    assert.deepEqual(Object.keys(cfg), ['connectionTimeout']);
});

test('REST-1b the write path is provably uncapped by a handler deadline', () => {
    const src = fs.readFileSync(path.join(HERE, 'lib', 'r2-transport-deadlines.js'), 'utf8');
    // Scope to the CONFIG FUNCTION BODY so prose in the doc comment cannot satisfy
    // or break this pin. A future edit reintroducing either key here reds it.
    const body = src.slice(src.indexOf('export function r2RequestHandlerConfig'));
    const cfgBody = body.slice(0, body.indexOf('}'));
    assert.equal(/requestTimeout/.test(cfgBody), false, 'no requestTimeout may be configured');
    assert.equal(/throwOnRequestTimeout/.test(cfgBody), false);
    assert.match(cfgBody, /connectionTimeout: R2_CONNECTION_TIMEOUT_MS/);
    const mean = (19682.1 / 295.6) / 5;              // MB/s per stream
    assert.ok(182.2 / mean > 13 && 182.2 / mean < 14, 'mean PUT ~13.7s at the healthy write rate');
});

test('REST-1b createR2Client actually installs the deadlines', () => {
    const src = fs.readFileSync(path.join(HERE, 'lib', 'r2-helpers.js'), 'utf8');
    assert.match(src, /requestHandler: r2RequestHandlerConfig\(\)/);
    assert.match(src, /import \{ r2RequestHandlerConfig \} from '\.\/r2-transport-deadlines\.js'/);
});

// --- the wedged-stream acceptance criterion --------------------------------

test('REST-1b WEDGED STREAM: the idle deadline fires a NAMED failure, not silence', async () => {
    const body = wedgedBody([Buffer.from('partial-payload')]);
    let fired = null;
    await assert.rejects(
        () => readBodyWithIdleDeadline(body, {
            idleMs: 25,
            // Deterministic: fire the deadline immediately rather than sleeping.
            setTimer: (fn) => setTimeout(fn, 1),
            clearTimer: (t) => clearTimeout(t),
        }),
        (e) => { fired = e; return e.name === 'TimeoutError'; },
    );
    assert.equal(fired.code, 'ETIMEDOUT');
    assert.equal(fired.streamIdleTimeout, true);
    // The socket is released rather than left wedged.
    assert.equal(body.destroyed, true, 'a stalled body must be destroyed');
});

test('REST-1b the idle error is classified RETRYABLE/transport by the existing classifier', () => {
    const c = classifyR2Error(createStreamIdleError(60000));
    assert.equal(c.retryable, true, 'withR2Retry must see it as retryable');
    assert.equal(c.terminal, 'transport');
    // => it reaches the failed counter honestly instead of hanging.
});

test('REST-1b the idle error carries NO key, body or credential', () => {
    const msg = `${createStreamIdleError(60000).message}`;
    for (const s of ['state/registry', 'part-', 'AKIA', 'X-Amz-Signature', '.bin']) {
        assert.equal(msg.includes(s), false, `deadline error leaked: ${s}`);
    }
});

// --- zero regression on the healthy path -----------------------------------

test('REST-1b a healthy body is read byte-identically and never trips', async () => {
    const parts = [Buffer.from('hello '), Buffer.from('world'), Buffer.alloc(4096, 7)];
    const out = await readBodyWithIdleDeadline(healthyBody(parts), { idleMs: 60000 });
    assert.deepEqual(out, Buffer.concat(parts));
});

test('REST-1b an empty body yields an empty buffer', async () => {
    const out = await readBodyWithIdleDeadline(healthyBody([]), { idleMs: 60000 });
    assert.equal(out.length, 0);
});

test('REST-1b a SLOW but progressing stream does NOT trip the idle deadline', async () => {
    // Inactivity budget, not a total budget: many chunks, each within the budget.
    const slow = {
        async *[Symbol.asyncIterator]() {
            for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 2)); yield Buffer.from('x'); }
        },
    };
    const out = await readBodyWithIdleDeadline(slow, { idleMs: 200 });
    assert.equal(out.length, 20, 'slowness must degrade into slowness, never a false red');
});

// --- D-441 SS 3: progress must be BYTE-LEVEL, never request-level ------------

test('REST-1b D-441: a MID-BODY stall inside ONE open request trips the deadline', async () => {
    // Bytes flow for far longer than the idle budget, then stop DEAD while the
    // request is still open and the iterator never returns. A request-level notion
    // of liveness ("the request has not ended") would never fire here - which is
    // precisely the 08-16 shape, where members were mid-request, not un-started.
    const idleMs = 40;
    let delivered = 0;
    let destroyed = false;
    const stallsMidBody = {
        destroy() { destroyed = true; },
        async *[Symbol.asyncIterator]() {
            for (let i = 0; i < 10; i++) {           // ~10 x 20ms = 200ms >> idleMs
                await new Promise((r) => setTimeout(r, 20));
                delivered += 8;
                yield Buffer.alloc(8);
            }
            await new Promise(() => { /* bytes STOP; request stays open forever */ });
        },
    };
    await assert.rejects(
        () => readBodyWithIdleDeadline(stallsMidBody, { idleMs }),
        (e) => e.name === 'TimeoutError' && e.streamIdleTimeout === true,
    );
    // Proof the budget is re-armed by BYTE ARRIVAL: total elapsed (~200ms) was many
    // times idleMs (40ms) and did NOT trip while bytes were flowing.
    assert.ok(delivered >= 80, `stall came after ${delivered}B, i.e. genuinely mid-body`);
    assert.equal(destroyed, true);
});

test('REST-1b D-441: the deadline is armed per CHUNK, not once per request', () => {
    const src = fs.readFileSync(path.join(HERE, 'lib', 'r2-transport-deadlines.js'), 'utf8');
    const fn = src.slice(src.indexOf('export async function readBodyWithIdleDeadline'));
    // The timer is created INSIDE the read loop and cleared each iteration, so every
    // delivered chunk re-arms it. Armed once outside the loop it would degrade into a
    // total-transfer cap and would false-red on any large slow object.
    assert.ok(fn.indexOf('for (;;)') < fn.indexOf('setTimer('), 'timer must be armed inside the loop');
    assert.ok(fn.indexOf('setTimer(') < fn.indexOf('iterator.next()'), 'armed before each next()');
    assert.match(fn, /finally \{\s*if \(timer !== null\) clearTimer\(timer\);/);
});

test('REST-1b the deadline timer is NOT unref-ed (that is the silent-exit mechanism)', () => {
    const src = fs.readFileSync(path.join(HERE, 'lib', 'r2-transport-deadlines.js'), 'utf8');
    const fn = src.slice(src.indexOf('export async function readBodyWithIdleDeadline'));
    assert.equal(/unref/.test(fn), false,
        'a ref-ed deadline is what keeps the loop alive until the wedge is reported');
});

test('REST-1b the restore body read goes THROUGH the deadline', () => {
    const src = fs.readFileSync(path.join(HERE, 'lib', 'r2-handoff.js'), 'utf8');
    assert.match(src, /const data = await readBodyWithIdleDeadline\(resp\.Body\);/);
    // The unguarded raw drain must be gone.
    assert.equal(/for await \(const c of resp\.Body\)/.test(src), false,
        'the undeadlined body drain must not survive');
});

test('REST-1b MUTATION: removing the deadline restores the unbounded hang', async () => {
    // Control that the wedge fixture really does hang without the deadline.
    const body = wedgedBody([Buffer.from('a')]);
    const raced = await Promise.race([
        (async () => { const chunks = []; for await (const c of body) chunks.push(c); return 'DRAINED'; })(),
        new Promise((r) => setTimeout(() => r('STILL-HANGING'), 60)),
    ]);
    assert.equal(raced, 'STILL-HANGING',
        'without a deadline the wedged body never completes => the deadline is load-bearing');
});
