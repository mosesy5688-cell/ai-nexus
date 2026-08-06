// D-2026-0806-404: T-2 (OOM resistance at a PINNED ceiling) and T-6 (RED
// demonstration of the DEFERRED R4 backpressure defect).
// Hermetic: synthetic fixtures generated in-process, no network, no credentials,
// no real shard data. Child processes run under an explicitly pinned heap limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READER = path.join(HERE, 'lib', 'ndjson-byte-reader.js').replace(/\\/g, '/');
const MiB = 1024 * 1024;

// ---------------------------------------------------------------------------
// T-2 SCALING ARGUMENT (documented, not hand-waved)
//
// The defect is that readline's read-ahead is COUNT-bounded at ~1,024 lines with
// zero byte accounting. Whether that OOMs is decided by ONE inequality:
//     QUEUE_LINES x LINE_BYTES  >  HEAP_LIMIT
// PRODUCTION : 1,024 x ~6 MiB  = ~6,156 MiB  vs 6,144 MiB limit -> ratio 1.002
// THIS TEST  : 1,024 x 1 MiB   = ~1,024 MiB  vs   256 MiB limit -> ratio 4.0
// The test therefore reproduces the SAME inequality with MORE margin, at 1/24th
// the memory and a few seconds of runtime. Pinning the child at 256 MiB keeps it
// hermetic and fast; it does not weaken the property under test.
// ---------------------------------------------------------------------------
const PINNED_HEAP_MIB = 256;
const LINE_BYTES = 1 * MiB;
const LINE_COUNT = 600;

/** Source that synthesises the adversarial profile without materialising it. */
const GEN_SRC = `
const LINE_BYTES = ${LINE_BYTES}, LINE_COUNT = ${LINE_COUNT};
const { Readable } = require('stream');
function makeSource() {
  let n = 0;
  return new Readable({
    read() {
      if (n >= LINE_COUNT) { this.push(null); return; }
      n += 1;
      this.push(Buffer.alloc(LINE_BYTES, 0x78));
      this.push(Buffer.from('\\n'));
    }
  });
}
`;

function runChild(body, label) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oomt2-')), `${label}.cjs`);
    fs.writeFileSync(file, GEN_SRC + body);
    try {
        const out = execFileSync(process.execPath, [`--max-old-space-size=${PINNED_HEAP_MIB}`, file], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000,
        });
        return { status: 0, out, err: '' };
    } catch (e) {
        return { status: e.status === null || e.status === undefined ? -1 : e.status, out: e.stdout || '', err: e.stderr || '' };
    } finally {
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
}

test(`T-2(a) RED: the OLD count-bounded readline path exhausts a pinned ${PINNED_HEAP_MIB} MiB heap`, () => {
    const r = runChild(`
const readline = require('readline');
(async () => {
  const rl = readline.createInterface({ input: makeSource(), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    n += 1;
    await new Promise((res) => setImmediate(res)); // slow consumer
  }
  console.log('COMPLETED ' + n);
})().catch((e) => { console.error('ERR ' + e.message); process.exit(3); });
`, 'red');
    const heapDeath = /Reached heap limit|JavaScript heap out of memory|Allocation failed/i.test(r.err);
    assert.equal(r.out.includes('COMPLETED'), false, 'the OLD path must NOT complete');
    assert.ok(heapDeath || r.status === 134 || r.status === 3 || r.status < 0,
        `expected heap exhaustion; status=${r.status} err=${r.err.slice(0, 300)}`);
    assert.ok(heapDeath, `expected a V8 heap-limit abort in stderr; got: ${r.err.slice(0, 300)}`);
});

test(`T-2(b) GREEN: the NEW byte-bounded reader completes the SAME profile under the SAME ${PINNED_HEAP_MIB} MiB limit`, () => {
    const r = runChild(`
(async () => {
  const { readNdjsonLines, READER_RETAINED_CAP_BYTES } = await import('file://${READER}');
  let peak = 0, n = 0;
  for await (const line of readNdjsonLines(makeSource(), { onRetained: (b) => { if (b > peak) peak = b; } })) {
    if (line.length !== ${LINE_BYTES}) { console.error('BAD LINE LEN ' + line.length); process.exit(4); }
    n += 1;
    await new Promise((res) => setImmediate(res)); // identical slow consumer
  }
  console.log('COMPLETED ' + n + ' PEAK ' + peak + ' CAP ' + READER_RETAINED_CAP_BYTES);
})().catch((e) => { console.error('ERR ' + e.message); process.exit(3); });
`, 'green');
    assert.equal(r.status, 0, `expected clean exit; status=${r.status} err=${r.err.slice(0, 400)}`);
    const m = r.out.match(/COMPLETED (\d+) PEAK (\d+) CAP (\d+)/);
    assert.ok(m, `expected completion line; got: ${r.out.slice(0, 300)} ${r.err.slice(0, 300)}`);
    assert.equal(Number(m[1]), LINE_COUNT, 'every record must be processed');
    const peak = Number(m[2]), cap = Number(m[3]);
    assert.ok(peak <= cap, `peak ${peak} must stay within READER_RETAINED_CAP_BYTES ${cap}`);
    // And far below the pinned heap: the whole point of the repair.
    assert.ok(peak < PINNED_HEAP_MIB * MiB, `peak ${peak} must be well under the pinned heap`);
});

// ---------------------------------------------------------------------------
// T-6 IS NOT A GATE. It is a RED DEMONSTRATION of defect D-3, whose repair (R4)
// is DEFERRED to a separate lane and is NOT implemented here. This test asserts
// that the defect is STILL PRESENT. It must never be read as R4 repaired.
//
// Per erratum v2 E2-A the production module cannot be executed in this lane
// (rust/stream-aggregator/stream-aggregator-rust.node is absent and this lane
// may not dispatch a runner or reach R2). Following erratum v2's S-2, this
// reproduces the offending CODE SHAPE - `rs.on('data', d => this.push(d))` with
// the return value discarded - NOT zstd-helper.js itself. Labelled as such.
// ---------------------------------------------------------------------------
test('T-6 [RED-DEMO, DEFERRED R4, NOT A GATE] push()===false is ignored and the buffer overshoots highWaterMark', async () => {
    const HWM = 64 * 1024;
    const CHUNK = HWM;
    const CHUNKS = 400;
    const source = Readable.from(Array.from({ length: CHUNKS }, () => Buffer.alloc(CHUNK, 0x7a)));

    // The offending shape, reproduced verbatim in structure.
    const sink = new Readable({ highWaterMark: HWM, read() {} });
    let pushed = 0, falseReturns = 0, peak = 0;
    await new Promise((resolve) => {
        source.on('data', (d) => {
            const ok = sink.push(d);   // <-- return value DISCARDED, as in the defect
            pushed += 1;
            if (ok === false) falseReturns += 1;
            if (sink.readableLength > peak) peak = sink.readableLength;
        });
        source.on('end', resolve);
    });

    assert.equal(pushed, CHUNKS, 'all chunks pushed');
    assert.ok(falseReturns > 0, 'push() must have signalled backpressure');
    // Erratum v2 S-2 measured exactly this: 400 pushes, 400 false returns, ALL ignored.
    assert.equal(falseReturns, CHUNKS, `EVERY push returned false and was ignored; got ${falseReturns}`);
    // THE DEFECT: retained bytes grow to the entire payload despite the HWM.
    const overshoot = peak / HWM;
    assert.ok(overshoot >= 100, `expected a large HWM overshoot (defect present); got ${overshoot}x`);
    assert.equal(peak, CHUNKS * CHUNK, `buffer grew to the whole payload: ${peak} B vs HWM ${HWM} B`);
    console.log(`[T-6 RED-DEMO] peak=${peak} B hwm=${HWM} B overshoot=${overshoot}x falseReturns=${falseReturns} -- D-3 PRESENT, R4 DEFERRED`);
});
