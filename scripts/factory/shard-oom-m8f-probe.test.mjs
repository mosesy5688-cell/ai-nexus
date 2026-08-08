// M8.f (D-2026-0808-405 A1 ④): pin the EXACT shard-count gate in
// .github/workflows/factory-aggregate.yml — the `-ne 20` final validation that
// guards what the aggregator is allowed to consume.
//
// WHY THIS IS A SEPARATE PIN FROM M8.c
// M8.c (shard-oom-q8-invariant.test.mjs) pins the PRODUCER-side gate in
// factory-process.yml, and pins it AS THE CODE ACTUALLY IS: a `-lt 20` FLOOR.
// That note explicitly records that erratum v2's `-ne 20` description did not
// match factory-process.yml. It does match the CONSUMER-side gate here, in
// factory-aggregate.yml, which was never pinned. A floor accepts 21; only `-ne`
// rejects both 19 and 21. This probe pins the exactness itself: the variable
// under test, the operator, the operand, the fail-closed tail, and the job/step
// the gate lives in.
//
// Hermetic: workflow text is READ ONLY. Every mutation below is applied to an
// IN-MEMORY copy. Nothing on disk is written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const AGGREGATE_YML = path.join(ROOT, '.github', 'workflows', 'factory-aggregate.yml');

const JOB = 'merge-core-compute';
const STEP = 'Organize Shards & Context';
// The gate, verbatim. Kept as one constant so a drift in ANY token is one edit
// away from turning every assertion below RED.
const GATE_LINE = 'if [ "$FINAL_COUNT" -ne 20 ]; then';
// The producer of the value the gate tests, in the same step, before the gate.
const COUNT_PRODUCER = 'FINAL_COUNT=$(ls artifacts/shard-*.json.zst 2>/dev/null | wc -l)';

// Normalise to LF. The repo blob is LF, and CI checks out LF, but a Windows
// working copy with core.autocrlf=true has CRLF on disk. The pin must describe
// the canonical file, not the checkout's line-ending policy.
const yml = () => fs.readFileSync(AGGREGATE_YML, 'utf8').replace(/\r\n/g, '\n');
const countOf = (hay, needle) => hay.split(needle).length - 1;

/** Slice one top-level job out of the workflow by name. */
function jobSlice(text, job) {
    const lines = text.split('\n');
    const s = lines.findIndex((l) => l === `  ${job}:`);
    assert.ok(s >= 0, `job ${job} must exist in factory-aggregate.yml`);
    let e = lines.length;
    for (let i = s + 1; i < lines.length; i++) {
        if (/^ {2}[A-Za-z0-9_-]+:$/.test(lines[i])) { e = i; break; }
    }
    return lines.slice(s, e).join('\n');
}

/** Slice one step out of a job slice by its exact step name. */
function stepSlice(jobText, step) {
    const lines = jobText.split('\n');
    const s = lines.findIndex((l) => l === `      - name: ${step}`);
    assert.ok(s >= 0, `step "${step}" must exist in the job slice`);
    let e = lines.length;
    for (let i = s + 1; i < lines.length; i++) {
        if (/^ {6}- name: /.test(lines[i])) { e = i; break; }
    }
    return lines.slice(s, e).join('\n');
}

// --- M8.f.1  the gate is present, and present EXACTLY ONCE ------------------
test('M8.f.1 the -ne 20 shard-count gate exists exactly once in factory-aggregate.yml', () => {
    const text = yml();
    assert.equal(countOf(text, GATE_LINE), 1,
        `the gate must appear EXACTLY once in the whole file (exact count, not a floor): ${GATE_LINE}`);
    // MUTATION: delete the gate -> RED.
    const deleted = text.replace(GATE_LINE, '');
    assert.equal(countOf(deleted, GATE_LINE), 0, 'deleting the gate must turn this pin RED');
});

// --- M8.f.2  the gate sits in the right job AND the right step --------------
test('M8.f.2 the gate lives in merge-core-compute / "Organize Shards & Context"', () => {
    const text = yml();
    const job = jobSlice(text, JOB);
    const step = stepSlice(job, STEP);
    assert.equal(countOf(job, GATE_LINE), 1, `the gate must be inside job ${JOB}`);
    assert.equal(countOf(step, GATE_LINE), 1, `the gate must be inside step "${STEP}"`);
    // The value it tests must be produced in the SAME step, BEFORE the gate, from
    // the verified shard artifacts - not inherited from some earlier step.
    assert.equal(countOf(step, COUNT_PRODUCER), 1, 'FINAL_COUNT must be produced in this step');
    assert.ok(step.indexOf(COUNT_PRODUCER) < step.indexOf(GATE_LINE),
        'FINAL_COUNT must be assigned BEFORE the gate reads it');
    // MUTATION: relocating the gate out of the step must turn the slice RED.
    const relocated = step.replace(GATE_LINE, 'if false; then');
    assert.equal(countOf(relocated, GATE_LINE), 0, 'removing the gate from the step must turn this pin RED');
});

// --- M8.f.3  the operator is -ne and the operand is 20 ----------------------
// Parsed, not substring-matched, so operator drift and operand drift are pinned
// INDEPENDENTLY. A `-lt 20` floor would accept a 21-shard set; `-ne 20` does not.
test('M8.f.3 the gate operator is exactly -ne and the operand is exactly 20', () => {
    const step = stepSlice(jobSlice(yml(), JOB), STEP);
    const gateLine = step.split('\n').find((l) => l.includes('"$FINAL_COUNT"'));
    assert.ok(gateLine, 'a line testing "$FINAL_COUNT" must exist in the step');
    const m = /^\s*if \[ "\$FINAL_COUNT" (-[a-z]{2}) (\d+) \]; then$/.exec(gateLine);
    assert.ok(m, `the gate must parse as a single shell integer comparison; got: ${gateLine}`);
    assert.equal(m[1], '-ne', 'the operator must be -ne (exact), never a -lt/-le/-gt floor');
    assert.equal(m[2], '20', 'the operand must be exactly 20');

    // MUTATION A: weaken -ne to the -lt floor -> RED on the operator assertion.
    const floorLine = gateLine.replace('-ne 20', '-lt 20');
    const mFloor = /^\s*if \[ "\$FINAL_COUNT" (-[a-z]{2}) (\d+) \]; then$/.exec(floorLine);
    assert.equal(mFloor[1], '-lt', 'control: the floor mutation parses');
    assert.notEqual(mFloor[1], '-ne', 'weakening -ne to a floor must turn this pin RED');

    // MUTATION B: change the operand -> RED on the operand assertion.
    const operandLine = gateLine.replace('-ne 20', '-ne 1');
    const mOperand = /^\s*if \[ "\$FINAL_COUNT" (-[a-z]{2}) (\d+) \]; then$/.exec(operandLine);
    assert.notEqual(mOperand[2], '20', 'changing the operand must turn this pin RED');
});

// --- M8.f.4  the gate fails closed (exit 1), it does not warn ---------------
test('M8.f.4 the gate body carries exit 1 and no warning-only escape', () => {
    const step = stepSlice(jobSlice(yml(), JOB), STEP);
    const at = step.indexOf(GATE_LINE);
    assert.ok(at > 0, 'the gate must be present');
    // The gate's own if-block, up to its `fi`.
    const after = step.slice(at + GATE_LINE.length);
    const fiAt = after.indexOf('\n          fi');
    assert.ok(fiAt > 0, 'the gate block must be terminated by a matching fi');
    const body = after.slice(0, fiAt);
    assert.ok(/^\s*exit 1\s*$/m.test(body), 'the gate body must exit 1');
    assert.equal(/\bcontinue\b|\|\| true|::warning::/.test(body), false,
        'the gate body must not contain a warning-only or continue escape');
    // MUTATION: strip the exit 1 -> RED.
    const mutatedBody = body.replace(/^(\s*)exit 1\s*$/m, '$1echo soft');
    assert.equal(/^\s*exit 1\s*$/m.test(mutatedBody), false, 'removing exit 1 must turn this pin RED');
});
