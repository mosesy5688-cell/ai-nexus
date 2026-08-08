// T3 negative space (D-2026-0808-405): the heartbeat is OBSERVATION ONLY.
// Pins that restore semantics are byte-for-byte what they were, and that the
// progress calls are wired into the real restore loop with a finally teardown.
// Hermetic - static source reads plus an in-memory mutation. No network/R2.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HANDOFF = path.join(HERE, 'lib', 'r2-handoff.js');
const src = fs.readFileSync(HANDOFF, 'utf8');

test('T3 concurrency stays 5 and is neither read nor rewritten by telemetry', () => {
    assert.match(src, /const \{ concurrency = 5, strict = false \} = opts;/);
    assert.match(src, /for \(let i = 0; i < keys\.length; i \+= concurrency\)/);
    assert.match(src, /keys\.slice\(i, i \+ concurrency\)/);
    // The progress object only RECEIVES concurrency; it must never assign it.
    assert.equal(/prog\.\w+\s*=/.test(src), false, 'telemetry must not be assigned into');
    assert.equal(/concurrency\s*=\s*prog/.test(src), false);
});

test('T3 the strict success predicate and manifest validation are unchanged', () => {
    // manifest-only strict behaviour: no LIST bypass
    assert.match(src, /if \(strict\) \{[^\n]*manifest_required_strict/);
    // exact success predicate, both paths
    const preds = src.match(/const success = \w+\.length > 0 && restored\.size === \w+\.length && missing\.length === 0 && failedArr\.length === 0;/g);
    assert.equal(preds && preds.length, 2, 'both success predicates must survive verbatim');
    // path-traversal + duplicate + absolute guards
    assert.match(src, /path\.isAbsolute\(f\) \|\| f\.split\(\/\[\\\\\/\]\/\)\.includes\('\.\.'\)/);
    assert.match(src, /new Set\(list\)\.size !== list\.length/);
    assert.match(src, /manifest\.count !== list\.length/);
});

test('T3 missing/failed classification is unchanged', () => {
    assert.match(src, /const missing = list\.filter\(\(f\) => !restored\.has\(f\)\);/);
    assert.match(src, /catch \{ failedArr\.push\(rel\); prog\.onFailed\(\); \}/);
    // failure classification still happens BEFORE any telemetry call in the chain
    assert.match(src, /restored\.add\(rel\); prog\.onRestored\(g && g\.size\);/);
});

test('T3 the returned public result shape is unchanged', () => {
    const m = src.match(/const R = \(success, o = \{\}\) => \(\{([^;]*)\}\);/s);
    assert.ok(m, 'result builder R must exist');
    for (const k of ['count', 'expected', 'restored', 'missing', 'failed', 'manifestFound', 'source']) {
        assert.ok(m[1].includes(`${k}:`), `result field ${k} must survive`);
    }
    // No telemetry field leaked into the public shape.
    assert.equal(/progress|heartbeat|elapsed/i.test(m[1]), false, 'no telemetry field in the result');
});

test('T3 BLOCKING-2: restore opts CANNOT inject telemetry dependencies', () => {
    // Reviewer B (D-2026-0808-407) demonstrated that `...(opts.progressDeps || {})` let a
    // caller override expected/concurrency/intervalMs/emit through the PUBLIC opts of
    // restoreDirectoryFromR2, which is a live path for an object key or an upstream error
    // string to reach telemetry. The seam is DELETED. Tests inject createRestoreProgress
    // directly and never need it.
    assert.equal(/progressDeps/.test(src), false, 'no progressDeps seam may exist');
    // The construction site takes ONLY the two derived values - nothing caller-supplied.
    assert.match(src, /createRestoreProgress\(\{ expected: keys\.length, concurrency \}\)/);
    assert.equal(/createRestoreProgress\(\{[^}]*\.\.\./.test(src), false, 'no spread into the progress constructor');
    // And no other opts field may be forwarded into telemetry either.
    assert.equal(/createRestoreProgress\(\{[^}]*opts\./.test(src), false, 'opts must not reach telemetry');
});

test('T3 BLOCKING-2 MUTATION: restoring the injection seam reds the pin', () => {
    const mutated = src.replace(
        'createRestoreProgress({ expected: keys.length, concurrency })',
        'createRestoreProgress({ expected: keys.length, concurrency, ...(opts.progressDeps || {}) })');
    assert.notEqual(mutated, src, 'mutation must apply');
    assert.equal(/progressDeps/.test(mutated), true, 'seam is back => the pin goes RED');
    assert.equal(/createRestoreProgress\(\{[^}]*\.\.\./.test(mutated), true, 'spread is back => RED');
});

test('T3 the heartbeat is torn down in a finally on the real restore loop', () => {
    assert.match(src, /const prog = createRestoreProgress\(\{ expected: keys\.length, concurrency/);
    assert.match(src, /\} finally \{ prog\.stop\(/, 'stop() must run from a finally');
    // The finally must wrap the batch loop, so a throw mid-restore still tears down.
    const loop = src.slice(src.indexOf('const restoreEach'), src.indexOf('// 1. Manifest GET'));
    assert.ok(loop.indexOf('try {') < loop.indexOf('for (let i = 0'), 'try must open before the batch loop');
    assert.ok(loop.indexOf('} finally {') > loop.indexOf('await Promise.all'), 'finally must close after it');
});

test('T3 MUTATION: dropping the finally teardown reds the teardown pin', () => {
    const mutated = src.replace(/\} finally \{ prog\.stop\([^)]*\); \}/, '}');
    assert.notEqual(mutated, src, 'mutation must apply');
    assert.equal(/\} finally \{ prog\.stop\(/.test(mutated), false, 'teardown pin goes RED');
});

test('T3 MUTATION: weakening the strict success predicate reds the semantics pin', () => {
    const mutated = src.replace(
        /const success = keys\.length > 0 && restored\.size === keys\.length && missing\.length === 0 && failedArr\.length === 0;/,
        'const success = restored.size > 0;');
    assert.notEqual(mutated, src, 'mutation must apply');
    const preds = mutated.match(/const success = \w+\.length > 0 && restored\.size === \w+\.length && missing\.length === 0 && failedArr\.length === 0;/g);
    assert.equal(preds && preds.length, 1, 'only one predicate survives => RED');
});

test('T3 no retry/backoff or AWS SDK config was touched', () => {
    // The shared retry wrapper still governs the manifest GET and the LIST.
    assert.match(src, /withR2Retry\(/);
    // NOTE: the file legitimately mentions the SDK global maxAttempts in a comment at
    // base; asserting its ABSENCE would be false. The real property is that the RESTORE
    // LOOP introduces no retry of its own - telemetry must not add or absorb attempts.
    const loop = src.slice(src.indexOf('const restoreEach'), src.indexOf('// 1. Manifest GET'));
    assert.equal(/withR2Retry|maxAttempts|retryMode|backoff|setTimeout|sleep/.test(loop), false,
        'the restore loop must contain no retry/backoff construct of its own');
    assert.equal((loop.match(/catch/g) || []).length, 1, 'exactly one catch - the pre-existing per-member one');
    // ContentLength short-read protection lives in the shared getter and is not bypassed.
    assert.match(src, /getObjectWithClient\(s3, prefix \+ rel, path\.join\(localDir, rel\)\)/);
});
