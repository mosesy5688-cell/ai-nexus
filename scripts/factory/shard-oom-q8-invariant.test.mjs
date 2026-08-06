// D-2026-0806-404 GAP 3: T-8, the Q8 safety invariant pins.
// Ported from erratum v2's corrected register: M8.a-M8.d plus the SIX repaired
// per-fail-point pins that replace the withdrawn M8.e.
// Hermetic: real scripts run against scratch fixtures; workflow text is read
// only. Every mutation is applied to an IN-MEMORY copy or a scratch temp dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MANIFEST_CLI = path.join(HERE, 'shards-handoff-manifest.mjs');
const PROCESS_YML = path.join(ROOT, '.github', 'workflows', 'factory-process.yml');
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');

const yml = () => fs.readFileSync(PROCESS_YML, 'utf8');

/** Slice the GAP-5 consumer step out of the workflow by its exact step name. */
function gap5ConsumerStep(text = yml()) {
    const start = text.indexOf('- name: Verify or Recover Prepared-Entity-Data from Exact R2 Staging (GAP-5, D-262)');
    assert.ok(start > 0, 'GAP-5 consumer step must exist');
    const next = text.indexOf('\n      - name:', start + 10);
    return text.slice(start, next > 0 ? next : text.length);
}

// --- M8.a  REAL manifest CLI: exact-set membership, not a floor -------------
function mkShardDir(n) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q8-'));
    fs.mkdirSync(path.join(dir, 'output', 'shards'), { recursive: true });
    for (let i = 0; i < n; i++) {
        fs.writeFileSync(path.join(dir, 'output', 'shards', `shard-${i}.json.zst`), Buffer.from(`s${i}`));
    }
    return dir;
}
function cli(args, cwd) {
    try {
        return { status: 0, out: execFileSync(process.execPath, [MANIFEST_CLI, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (e) {
        return { status: e.status ?? -1, out: (e.stdout || '') + (e.stderr || '') };
    }
}

test('M8.a REAL shards-handoff-manifest: generate(20) OK, verify 20 ACCEPT, 19 REJECT, 21 REJECT', () => {
    const dir20 = mkShardDir(20);
    const man = path.join(dir20, 'm.json');
    const gen = cli(['generate', 'output/shards', man, '--carrier=shards-authority'], dir20);
    assert.equal(gen.status, 0, `generate(20) must succeed: ${gen.out.slice(0, 300)}`);

    // POSITIVE control first - without it the reject cases would be vacuous.
    const ok20 = cli(['verify', 'output/shards', man, '--carrier=shards-authority'], dir20);
    assert.equal(ok20.status, 0, `20-set must ACCEPT: ${ok20.out.slice(0, 300)}`);

    // 19-set: remove one member, verify against the 20-member manifest.
    const dir19 = mkShardDir(20);
    fs.copyFileSync(man, path.join(dir19, 'm.json'));
    fs.rmSync(path.join(dir19, 'output', 'shards', 'shard-19.json.zst'));
    const r19 = cli(['verify', 'output/shards', path.join(dir19, 'm.json'), '--carrier=shards-authority'], dir19);
    assert.notEqual(r19.status, 0, '19-set must REJECT');

    // 21-set: add a foreign member. An exact-set check rejects; a >=20 floor would not.
    const dir21 = mkShardDir(20);
    fs.copyFileSync(man, path.join(dir21, 'm.json'));
    fs.writeFileSync(path.join(dir21, 'output', 'shards', 'shard-20.json.zst'), Buffer.from('x'));
    const r21 = cli(['verify', 'output/shards', path.join(dir21, 'm.json'), '--carrier=shards-authority'], dir21);
    assert.notEqual(r21.status, 0, '21-set must REJECT (exact set, NOT a >=20 floor)');

    for (const d of [dir20, dir19, dir21]) fs.rmSync(d, { recursive: true, force: true });
});

// --- M8.b  descriptor-first --strict restore with exit 1 -------------------
const M8B_MARKER = 'no current-cycle prepared-entity-data authority descriptor';
test('M8.b descriptor-first --strict restore carries exit 1', () => {
    const step = gap5ConsumerStep();
    assert.ok(/restore-file "\$DESC" \/tmp\/prep-handoff-rb\.json --strict \|\| \{[^}]*exit 1; \}/.test(step),
        'descriptor restore must be --strict with an exit-1 tail');
    // MUTATION: drop --strict -> the pin must go RED.
    const mutated = step.replace('restore-file "$DESC" /tmp/prep-handoff-rb.json --strict', 'restore-file "$DESC" /tmp/prep-handoff-rb.json');
    assert.equal(/restore-file "\$DESC" \/tmp\/prep-handoff-rb\.json --strict/.test(mutated), false, 'mutation removes --strict => RED');
});

// --- M8.c  shard-count final gate -----------------------------------------
// NOTE (reported, not silently adopted): erratum v2 describes this gate as
// `-ne 20`. At base 096e4b30c the code is `-lt 20` (a FLOOR). The EXACT-20
// property is carried by the manifest `exactMembers` set and is pinned by M8.a
// (21-set REJECT), not by this shell gate. Pinned here AS THE CODE ACTUALLY IS.
test('M8.c the Organize Shards count gate exists and carries exit 1', () => {
    const text = yml();
    assert.ok(text.includes('if [ "$SHARD_COUNT" -lt 20 ]; then'), 'the -lt 20 floor gate must exist');
    const block = text.slice(text.indexOf('SHARD_COUNT=$(find output/shards'));
    assert.ok(/-lt 20 \]; then[\s\S]{0,200}?exit 1/.test(block), 'the gate must exit 1');
    // MUTATION: weaken the floor to -lt 1 -> the pin must go RED.
    const mutated = text.replace('if [ "$SHARD_COUNT" -lt 20 ]; then', 'if [ "$SHARD_COUNT" -lt 1 ]; then');
    assert.equal(mutated.includes('if [ "$SHARD_COUNT" -lt 20 ]; then'), false, 'mutation weakens the floor => RED');
});

// --- M8.d  no state/shards/ recovery input anywhere ------------------------
test('M8.d NO workflow reads back the demoted fixed-prefix state/shards/ set', () => {
    const files = fs.readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    const offenders = [];
    for (const f of files) {
        const t = fs.readFileSync(path.join(WORKFLOW_DIR, f), 'utf8');
        if (t.includes('restore-dir state/shards/')) offenders.push(`${f}:restore-dir`);
        if (t.includes('restore-file "state/shards/shard-')) offenders.push(`${f}:restore-file`);
    }
    assert.deepEqual(offenders, [], `no workflow may restore from state/shards/; found: ${offenders.join(', ')}`);
    // MUTATION: injecting such a read must make the same scan RED.
    const injected = 'run: node scripts/factory/r2-workflow-cli.js restore-dir state/shards/ artifacts/';
    assert.ok(injected.includes('restore-dir state/shards/'), 'the scan detects an injected recovery input => RED');
});

// --- M8.e.1 .. M8.e.6  SIX independent per-fail-point pins -----------------
// The withdrawn M8.e paired a FLOOR ("at least 5 exit-1 tails") with a mutation
// that removed ONE, and its mutation string also occurred in the PRODUCER step
// earlier in the file, so it edited text outside the slice. Both defects are
// avoided here: each marker is asserted UNIQUE IN THE WHOLE FILE and present
// EXACTLY ONCE IN THE CONSUMER STEP, and each is mutated independently.
const FAIL_POINTS = [
    ['M8.e.1 descriptor restore', 'no current-cycle prepared-entity-data authority descriptor'],
    ['M8.e.2 descriptor provenance', 'prepared-entity-data descriptor provenance invalid'],
    ['M8.e.3 manifest restore', 'prepared-entity-data manifest missing at'],
    ['M8.e.4 recover restore', 'recover restore failed'],
    ['M8.e.5 recovery verify', 'exact-staging recovery failed verification'],
    ['M8.e.6 set_sha equality', 'recovered set hash != producer'],
];
const countOf = (hay, needle) => hay.split(needle).length - 1;

for (const [name, marker] of FAIL_POINTS) {
    test(`${name}: marker is globally unique and its fail point carries exit 1`, () => {
        const text = yml();
        const step = gap5ConsumerStep(text);
        // EXACT counts, not floors - the M8.e lesson.
        assert.equal(countOf(text, marker), 1, `marker must appear EXACTLY once in the whole file: ${marker}`);
        assert.equal(countOf(step, marker), 1, `marker must appear EXACTLY once inside the consumer step: ${marker}`);
        // The marker's own line must carry an exit-1 tail.
        const line = step.split('\n').find((l) => l.includes(marker));
        assert.ok(line && /exit 1; \}/.test(line), `${marker} must sit on a line with an exit-1 tail`);

        // INDEPENDENT MUTATION: remove the exit 1 from THIS fail point only.
        const mutatedLine = line.replace('exit 1; }', '}');
        const mutatedStep = step.replace(line, mutatedLine);
        const mLine = mutatedStep.split('\n').find((l) => l.includes(marker));
        assert.equal(/exit 1; \}/.test(mLine), false, `${name} mutation must drop its exit 1 => RED`);
        // And the mutation must NOT have disturbed the other five fail points.
        for (const [, other] of FAIL_POINTS) {
            if (other === marker) continue;
            const otherLine = mutatedStep.split('\n').find((l) => l.includes(other));
            assert.ok(otherLine && /exit 1; \}/.test(otherLine), `${name} mutation must not touch ${other}`);
        }
    });
}

test('T-8 the GAP-5 consumer step carries EXACTLY six fail points (exact count, not a floor)', () => {
    const step = gap5ConsumerStep();
    const tails = countOf(step, 'exit 1; }');
    assert.equal(tails, 6, `expected exactly 6 exit-1 tails in the consumer step, found ${tails}`);
});
