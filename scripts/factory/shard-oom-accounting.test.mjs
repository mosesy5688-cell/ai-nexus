// D-6 accounting repair (D-2026-0808-410 R2, design v1 Option B).
// D6-R1 / D6-R3..R6 exercise the DEPLOYED shard-processor.js entry; M-D6.a/b/c
// mutate a scratch copy of that same deployed file, so the pins bind the shipped
// path rather than a reimplementation (the M8.e / F-1 lesson).
//
// Hermetic: tiny synthetic NDJSON fixtures in a temp cwd (autoDecompress passes
// non-zstd through). No network, no credentials, no R2, no real shard data.
//
// FIXTURE SEMANTICS, measured on the deployed entry (design v1 §1.6):
//   id WITHOUT '/'  -> entity-validator hasValidCachePath false -> success:false
//   id WITH    '/'  -> success:true
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNTING_TERMINAL_ALL_FAILED, ACCOUNTING_MARKER } from './lib/shard-accounting-gate.js';
import { autoDecompress } from './lib/zstd-helper.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROD = path.join(HERE, 'shard-processor.js');

const FAIL_ENTITY = (n) => JSON.stringify({ id: `abc${n}`, type: 'model' });      // no '/' -> fails
const OK_ENTITY = (n) => JSON.stringify({ id: `hf:ok${n}/m`, type: 'model' });    // has '/' -> succeeds

function makeCwd(lines) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd6-'));
    fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'cache', 'merged_shard_0.json.zst'), lines.join('\n') + (lines.length ? '\n' : ''));
    return dir;
}

function run(script, cwd) {
    try {
        const out = execFileSync(process.execPath, [script, '--shard=0', '--total=20'], {
            cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, CACHE_DIR: './cache' }, timeout: 300000,
        });
        return { status: 0, out, err: '', all: out };
    } catch (e) {
        return { status: e.status ?? -1, out: e.stdout || '', err: e.stderr || '', all: (e.stdout || '') + (e.stderr || '') };
    }
}

const artifact = (cwd) => path.join(cwd, 'artifacts', 'shard-0.json.zst');
/** The terminal is THROWN only if it reaches stderr; it also appears in telemetry. */
const threwTerminal = (r) => r.err.includes(ACCOUNTING_TERMINAL_ALL_FAILED);

/** Artifacts are zstd-compressed. Returns {raw, parsed|null}. */
async function readArtifact(cwd) {
    const p = artifact(cwd);
    if (!fs.existsSync(p)) return { raw: null, parsed: null };
    let raw;
    try { raw = (await autoDecompress(fs.readFileSync(p))).toString('utf8'); } catch { return { raw: null, parsed: null }; }
    try { return { raw, parsed: JSON.parse(raw) }; } catch { return { raw, parsed: null }; }
}

const telemetry = (all) => {
    const line = all.split('\n').find((l) => l.includes(ACCOUNTING_MARKER));
    return line ? JSON.parse(line.slice(line.indexOf(ACCOUNTING_MARKER) + ACCOUNTING_MARKER.length + 1)) : null;
};

/** The deployed guard block, matched as text so mutations bind the shipped file. */
const GUARD_RE = /    if \(successCount === 0 && processedCount > 0\) \{\r?\n.*\r?\n    \}\r?\n/;

/** Write a scratch copy of the DEPLOYED file with `edit` applied. */
function withMutant(edit, fn) {
    const original = fs.readFileSync(PROD, 'utf8');
    const mutated = edit(original);
    assert.notEqual(mutated, original, 'the mutation must actually change the deployed file');
    const p = path.join(HERE, `.tmp-mutant-d6-${process.pid}.js`);
    try { fs.writeFileSync(p, mutated); return fn(p); } finally { fs.rmSync(p, { force: true }); }
}

// --- D6-R1  ALL-FAILED, DEPLOYED ENTRY (the primary D-6 RED) ---------------
test('D6-R1 an all-entities-failed shard FAILS CLOSED on the deployed entry', async () => {
    const cwd = makeCwd([FAIL_ENTITY(1), FAIL_ENTITY(2)]);
    try {
        const r = run(PROD, cwd);
        assert.notEqual(r.status, 0, 'must exit non-zero (pre-fix this exited 0)');
        assert.ok(r.all.includes(ACCOUNTING_TERMINAL_ALL_FAILED), `named terminal missing: ${r.all.slice(-400)}`);
        assert.match(r.all, /success=0/);
        assert.match(r.all, /processed=2/);
        assert.match(r.all, /failed=2/);
        // The output stream is opened BEFORE the loop, so a PARTIAL file remains on
        // disk when the guard throws. What must never exist is a COMPLETE artifact:
        // the footer is never written, so it cannot be parsed as one. The failing
        // exit is what stops factory-process from ever collecting it.
        const partial = await readArtifact(cwd);
        assert.equal(partial.parsed, null, 'an all-failed shard must never yield a COMPLETE artifact');
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

// --- D6-R3  ORDERING REGRESSION PINS --------------------------------------
test('D6-R3 empty input still throws the EXACT pre-existing terminal', () => {
    const cwd = makeCwd([]);
    try {
        const r = run(PROD, cwd);
        assert.notEqual(r.status, 0);
        assert.match(r.all, /streamed 0 entities/);
        assert.equal(threwTerminal(r), false, 'the new guard must NOT steal this terminal');
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('D6-R3 all-malformed input still throws the EXACT pre-existing terminal', () => {
    const cwd = makeCwd(['NOT JSON', 'ALSO NOT JSON']);
    try {
        const r = run(PROD, cwd);
        assert.notEqual(r.status, 0);
        assert.match(r.all, /processed 0 entities/);
        assert.equal(threwTerminal(r), false, 'the new guard must NOT steal this terminal');
        const t = telemetry(r.all);
        assert.equal(t.malformedCount, 2, 'malformed lines are counted separately');
        assert.equal(t.processedCount, 0);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

// --- D6-R4  PARTIAL FAILURE PASSES (no invented threshold) -----------------
test('D6-R4 a partial failure (1 success + 3 failures) still SUCCEEDS', () => {
    const cwd = makeCwd([OK_ENTITY(1), FAIL_ENTITY(1), FAIL_ENTITY(2), FAIL_ENTITY(3)]);
    try {
        const r = run(PROD, cwd);
        assert.equal(r.status, 0, `partial failure must not fail closed: ${r.err.slice(-300)}`);
        assert.equal(threwTerminal(r), false);
        assert.ok(fs.existsSync(artifact(cwd)), 'artifact is still emitted');
        const t = telemetry(r.all);
        assert.equal(t.successCount, 1);
        assert.equal(t.failedCount, 3);
        assert.equal(t.ok, true);
        assert.equal(t.terminalCode, null);
        assert.ok(t.successRatio > 0.24 && t.successRatio < 0.26, `ratio ${t.successRatio}`);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

// --- D6-R5  NO CONTENT LEAK ------------------------------------------------
test('D6-R5 the terminal and telemetry leak NO entity content', () => {
    const TOKEN = 'ZZTOPSECRETPAYLOAD9911';
    const cwd = makeCwd([
        JSON.stringify({ id: 'abcleak', type: 'model', description: TOKEN }),
        JSON.stringify({ id: 'abcleak2', type: 'model', note: TOKEN }),
    ]);
    try {
        const r = run(PROD, cwd);
        assert.notEqual(r.status, 0);
        // Read the THROWN terminal from stderr: the telemetry line on stdout also
        // carries the code, so searching combined output would test the wrong line.
        const terminalLine = r.err.split('\n').find((l) => l.includes(ACCOUNTING_TERMINAL_ALL_FAILED));
        assert.ok(terminalLine, 'the THROWN terminal must be present on stderr');
        assert.equal(terminalLine.includes(TOKEN), false, 'terminal leaked entity content');
        assert.equal(terminalLine.includes('abcleak'), false, 'terminal leaked an entity id');
        const telemetryLine = r.all.split('\n').find((l) => l.includes(ACCOUNTING_MARKER));
        assert.equal(telemetryLine.includes(TOKEN), false, 'telemetry leaked entity content');
        assert.equal(telemetryLine.includes('abcleak'), false, 'telemetry leaked an entity id');
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

// --- D6-R6  FOOTER ADDITIVITY ---------------------------------------------
test('D6-R6 the footer gains FLAT scalar counters and stays parseable', async () => {
    const cwd = makeCwd([OK_ENTITY(1), FAIL_ENTITY(1), 'NOT JSON']);
    try {
        const r = run(PROD, cwd);
        assert.equal(r.status, 0, r.err.slice(-300));
        const { parsed: doc } = await readArtifact(cwd);
        assert.ok(doc, 'the artifact must parse');
        assert.equal(doc.successCount, 1);
        assert.equal(doc.failedCount, 1);
        assert.equal(doc.malformedCount, 1);
        assert.equal(doc.writeErrorCount, 0);
        assert.equal(doc.processedCount, 2);
        assert.equal(doc.totalSeen, 3);
        // FLAT SCALARS ONLY: aggregator-stream-utils scans every depth-1 {...} as an
        // entity candidate, so a nested footer object would be parsed as one.
        for (const k of ['failedCount', 'malformedCount', 'writeErrorCount']) {
            assert.equal(typeof doc[k], 'number', `${k} must be a flat scalar`);
        }
        assert.equal(Array.isArray(doc.entities), true);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

// --- M-D6.a  DELETE THE GUARD -> D6-R1 goes RED ---------------------------
test('M-D6.a deleting the new guard from the DEPLOYED file reds D6-R1', () => {
    const cwd = makeCwd([FAIL_ENTITY(1), FAIL_ENTITY(2)]);
    try {
        const r = withMutant(
            (s) => s.replace(/    if \(successCount === 0 && processedCount > 0\) \{\r?\n.*\r?\n    \}\r?\n/, ''),
            (p) => run(p, cwd));
        assert.equal(r.status, 0, 'without the guard the all-failed run exits 0 - the D-6 defect');
        assert.equal(threwTerminal(r), false, 'the terminal must not be THROWN (it still appears in telemetry)');
        assert.ok(fs.existsSync(artifact(cwd)), 'and it emits a shard of pure failures');
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

// --- M-D6.b  NEVER-TRUE PREDICATE -> D6-R1 goes RED -----------------------
test('M-D6.b flipping the predicate to a never-true form reds D6-R1', () => {
    const cwd = makeCwd([FAIL_ENTITY(1), FAIL_ENTITY(2)]);
    try {
        const r = withMutant(
            (s) => s.replace('if (successCount === 0 && processedCount > 0) {', 'if (successCount < 0) {'),
            (p) => run(p, cwd));
        assert.equal(r.status, 0, 'a never-true predicate restores the defect');
        assert.equal(threwTerminal(r), false, 'the terminal must not be THROWN');
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

// --- M-D6.c  ORDERING / PREDICATE-SHAPE PIN -------------------------------
// DESIGN CONTRADICTION, RESOLVED AND REPORTED (design v1 §2.1 vs §2.4/§3.3).
// §2.1 instructs the predicate be written SELF-CONTAINED as
// `successCount === 0 && processedCount > 0` precisely so it "survives any
// future reordering". §2.4/§3.3 then specify M-D6.c as "hoist the guard above
// the other two -> D6-R3 goes RED", whose proof assumes the PLAIN
// `successCount === 0` form ("All three predicates are true").
// Those cannot both hold: with the self-contained form, processedCount === 0 for
// BOTH pinned fixtures, so the third predicate is FALSE and a bare hoist changes
// nothing - M-D6.c as literally specified cannot go RED.
// MEASURED: bare hoist -> the all-malformed fixture still throws
// 'processed 0 entities'. §2.1 is followed exactly (the safer instruction); this
// control is re-aimed at the property that IS load-bearing: the `&& processedCount > 0`
// conjunct. Flagged for reviewer adjudication; §2.4/§3.3 are stale, not §2.1.
test('M-D6.c a bare hoist is INERT because the predicate is self-contained (design 2.1)', () => {
    const cwd = makeCwd(['NOT JSON', 'ALSO NOT JSON']);
    try {
        const r = withMutant((s2) => {
            const g = s2.match(GUARD_RE)[0];
            return s2.replace(g, '').replace('    if (entityIndex === 0) {', g + '    if (entityIndex === 0) {');
        }, (mp) => run(mp, cwd));
        assert.notEqual(r.status, 0);
        assert.match(r.all, /processed 0 entities/, 'the pinned terminal SURVIVES a bare hoist');
        assert.equal(threwTerminal(r), false);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('M-D6.c dropping `&& processedCount > 0` AND hoisting DOES steal the pinned terminal', () => {
    const cwd = makeCwd(['NOT JSON', 'ALSO NOT JSON']);
    try {
        const r = withMutant((s2) => {
            const g = s2.match(GUARD_RE)[0];
            const weakened = g.replace('successCount === 0 && processedCount > 0', 'successCount === 0');
            return s2.replace(g, '').replace('    if (entityIndex === 0) {', weakened + '    if (entityIndex === 0) {');
        }, (mp) => run(mp, cwd));
        assert.notEqual(r.status, 0);
        assert.equal(r.all.includes('processed 0 entities'), false,
            'the weakened+hoisted guard steals the pinned terminal => D6-R3 would be RED');
        assert.equal(threwTerminal(r), true, 'the new terminal fired instead');
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
