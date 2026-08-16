// F-1 write-error double-count repair (ruling D-414), D6-R7 style.
//
// DEFECT. shard-processor.js incremented processedCount in BOTH the try block and
// the catch block, so an entity whose WRITE path threw after processing began was
// counted twice: seen=1, processed=2. That breaks the seenConsistent invariant
// (seen === processed + malformed) that shard-accounting-gate.js asserts.
//
// FAULT INJECTION. processor-core.processEntity never throws (its whole body is in
// a try that returns {success:false}), so the outer catch is reachable only through
// the write path, which no NDJSON input can trigger on its own. These tests copy the
// DEPLOYED file and inject ONE throw inside safeWrite, keyed to a token that appears
// only in one fixture entity. The injection does not touch a single counter
// statement, so what is measured is the shipped counting logic (the M8.e / F-1
// lesson: pin the deployed path, never a reimplementation).
//
// Hermetic: synthetic NDJSON in a temp cwd (autoDecompress passes non-zstd through).
// No network, no credentials, no R2, no real shard data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNTING_MARKER } from './lib/shard-accounting-gate.js';
import { autoDecompress } from './lib/zstd-helper.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROD = path.join(HERE, 'shard-processor.js');

const BOOM = 'F1WRITEFAULTTOKEN';
const OK_ENTITY = (n) => JSON.stringify({ id: `hf:ok${n}/m`, type: 'model' });          // has '/' -> succeeds
const BOOM_ENTITY = JSON.stringify({ id: 'hf:boom/m', type: 'model', description: BOOM });

// Matchers bind the DEPLOYED text. They are EOL-agnostic: the repo checks out CRLF
// on Windows and LF in CI, so a literal '\n' matcher would silently no-op on one.
const nl = (s) => (s.includes('\r\n') ? '\r\n' : '\n');

// The deployed write helper: inject ONE throw above it, keyed to the fixture token.
const WRITE_LINE = "        if (!outStream.write(chunk)) await once(outStream, 'drain');";
const INJECT_WRITE_FAULT = (s) => s.replace(WRITE_LINE,
    `        if (String(chunk).includes('${BOOM}')) throw new Error('injected write fault');`
    + nl(s) + WRITE_LINE);

// The deployed single increment (post-fix) and the catch tail the second one lived in.
const SINGLE_INC_RE = /            processedCount\+\+;\r?\n(            const result = await processEntity\()/;
const CATCH_TAIL_RE = /(            writeErrorCount\+\+;)(\r?\n        \})/;

let mutantSeq = 0;
/** Run `edit`-ed copies of the DEPLOYED file; the deployed file itself is never written. */
function withEditedProd(edits, fn) {
    const original = fs.readFileSync(PROD, 'utf8');
    let mutated = original;
    for (const [i, e] of edits.entries()) {
        const next = e(mutated);
        // EVERY edit must bite. A matcher that silently stops binding would turn a
        // mutation pin into a tautology that passes against unmutated code.
        assert.notEqual(next, mutated, `edit ${i} did not change the deployed file`);
        mutated = next;
    }
    const p = path.join(HERE, `.tmp-mutant-f1-${process.pid}-${mutantSeq++}.js`);
    try { fs.writeFileSync(p, mutated); return fn(p); } finally { fs.rmSync(p, { force: true }); }
}

function makeCwd(lines) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-'));
    fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'cache', 'merged_shard_0.json.zst'), lines.join('\n') + '\n');
    return dir;
}

/** spawnSync, not execFileSync: the injected fault logs to stderr on an exit-0 run,
 *  and execFileSync surfaces stderr only when the child exits non-zero. */
function run(script, cwd) {
    const r = spawnSync(process.execPath, [script, '--shard=0', '--total=20'], {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CACHE_DIR: './cache' }, timeout: 300000,
    });
    const out = r.stdout || '', err = r.stderr || '';
    return { status: r.status ?? -1, out, err, all: out + err };
}

const telemetry = (all) => {
    const line = all.split('\n').find((l) => l.includes(ACCOUNTING_MARKER));
    return line ? JSON.parse(line.slice(line.indexOf(ACCOUNTING_MARKER) + ACCOUNTING_MARKER.length + 1)) : null;
};

async function readArtifact(cwd) {
    const p = path.join(cwd, 'artifacts', 'shard-0.json.zst');
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse((await autoDecompress(fs.readFileSync(p))).toString('utf8')); } catch { return null; }
}

/** One success, one entity that throws in the write path, one success. */
const FIXTURE = [OK_ENTITY(1), BOOM_ENTITY, OK_ENTITY(2)];

// --- F1-R1  THE INVARIANT (the primary F-1 RED) ----------------------------
test('F1-R1 a write-path throw keeps seen === processed on the deployed entry', () => {
    const cwd = makeCwd(FIXTURE);
    try {
        const r = withEditedProd([INJECT_WRITE_FAULT], (p) => run(p, cwd));
        assert.equal(r.status, 0, `the run must still complete: ${r.err.slice(-400)}`);
        assert.match(r.err, /injected write fault/, 'the fault must actually have fired');
        const t = telemetry(r.all);
        assert.ok(t, 'the accounting telemetry line must be present');
        assert.equal(t.totalSeen, 3);
        // Pre-fix this was 4: the boom entity incremented in BOTH try and catch.
        assert.equal(t.processedCount, 3, 'each entity must increment processedCount exactly once');
        assert.equal(t.totalSeen, t.processedCount + t.malformedCount, 'seenConsistent must hold');
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

// --- F1-R2  FAILURE COUNTING + FOOTER --------------------------------------
test('F1-R2 the write error is counted once and the footer carries the converged count', async () => {
    const cwd = makeCwd(FIXTURE);
    try {
        const r = withEditedProd([INJECT_WRITE_FAULT], (p) => run(p, cwd));
        assert.equal(r.status, 0, r.err.slice(-400));
        const t = telemetry(r.all);
        assert.equal(t.writeErrorCount, 1, 'exactly one write error');
        assert.equal(t.malformedCount, 0);
        assert.equal(t.failedCount, 0);
        // OUT OF F-1 SCOPE, PINNED AS MEASURED: the boom entity is ALSO counted in
        // successCount, because processEntity returned success before the write threw.
        // That bucket overlap (processed !== success + failed + writeErrors on this
        // path) predates F-1 and is NOT touched here; only the double count is.
        assert.equal(t.successCount, 3);
        assert.equal(t.successRatio, 1);
        const doc = await readArtifact(cwd);
        assert.ok(doc, 'the artifact must still parse');
        assert.equal(doc.processedCount, 3, 'the footer carries the converged count');
        assert.equal(doc.totalSeen, 3);
        assert.equal(doc.writeErrorCount, 1);
        assert.equal(doc.entities.length, 2, 'the entity that threw is not written');
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

// --- M-F1.a  RESTORE THE CATCH INCREMENT -> F1-R1 goes RED -----------------
test('M-F1.a restoring the second processedCount++ in the catch reds F1-R1', () => {
    const cwd = makeCwd(FIXTURE);
    try {
        const r = withEditedProd([
            INJECT_WRITE_FAULT,
            (s) => s.replace(CATCH_TAIL_RE, `$1${nl(s)}            processedCount++;$2`),
        ], (p) => run(p, cwd));
        assert.equal(r.status, 0, r.err.slice(-400));
        const t = telemetry(r.all);
        assert.equal(t.processedCount, 4, 'the restored second increment double-counts the boom entity');
        assert.notEqual(t.totalSeen, t.processedCount + t.malformedCount, 'seenConsistent breaks => F1-R1 is RED');
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

// --- M-F1.b  DELETE THE SINGLE INCREMENT -> F1-R1 goes RED -----------------
test('M-F1.b deleting the single processedCount++ reds F1-R1', () => {
    const cwd = makeCwd(FIXTURE);
    try {
        const r = withEditedProd([
            INJECT_WRITE_FAULT,
            (s) => s.replace(SINGLE_INC_RE, '$1'),
        ], (p) => run(p, cwd));
        assert.notEqual(r.status, 0, 'with no increment the run cannot account for anything');
        assert.match(r.all, /processed 0 entities/, 'the zero-processed terminal fires => F1-R1 is RED');
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

// --- M-F1.c  THE DEPLOYED FILE IS NEVER MUTATED IN PLACE -------------------
test('M-F1.c every mutant is byte-exactly reverted and none is left in the tree', () => {
    const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
    const before = sha(fs.readFileSync(PROD));
    withEditedProd([INJECT_WRITE_FAULT], (p) => assert.ok(fs.existsSync(p)));
    assert.equal(sha(fs.readFileSync(PROD)), before, 'the deployed file must be byte-identical');
    const leftovers = fs.readdirSync(HERE).filter((f) => f.startsWith('.tmp-mutant-f1-'));
    assert.deepEqual(leftovers, [], `mutant files left behind: ${leftovers.join(', ')}`);
});
