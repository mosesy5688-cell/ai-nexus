// OP-GR-B (ruling D-2026-0810-418): LIVE-PATH WIRING pins (static).
//
// Same shape as the M8.f probe: the workflow text is READ ONLY and compared
// against real files on disk. Nothing is written, no network, no credentials.
//
// The repo has a history of no-op fixes landed on dead paths, so this suite
// asserts what a reviewer would otherwise have to take on trust:
//   1. the step EXISTS in the job the cron actually runs, and invokes the CLI
//      file this PR adds;
//   2. it runs ONLY on a schedule event with the Founder flag set, so it is
//      unreachable by workflow_dispatch and, with the flag unset, cron
//      behaviour is byte-equivalent to today;
//   3. it sits AFTER the registry is loaded and BEFORE the first consumer --
//      a LINE-ORDER assertion, because "after load, before consumption" is the
//      whole correctness argument for the chosen authority target;
//   4. the restore/precedence logic it must NOT touch is still intact.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const HARVEST_YML = path.join(ROOT, '.github', 'workflows', 'factory-harvest.yml');
const TEST_SUITE_YML = path.join(ROOT, '.github', 'workflows', 'test-suite.yml');

const STEP = 'OP-GR-B One-Time Registry Re-normalisation (flag-gated)';
const UPLOAD_STEP = 'Upload OP-GR-B Artifacts (pre-image + manifests)';
const FLAG = 'OP_GR_B_RENORM';
const SCHEDULE = "github.event_name == 'schedule'";
const CLI = 'scripts/factory/registry-renorm-cli.js';

// Normalise to LF: the repo blob is LF and CI checks out LF, but a Windows
// working copy with core.autocrlf=true holds CRLF. The pin describes the
// canonical file, not the checkout's line-ending policy.
const yml = () => fs.readFileSync(HARVEST_YML, 'utf8').replace(/\r\n/g, '\n');
const lineOf = (text, needle) => {
    const at = text.split('\n').findIndex((l) => l.includes(needle));
    assert.ok(at >= 0, `expected to find "${needle}" in factory-harvest.yml`);
    return at;
};

test('G1 the workflow is valid YAML and the step exists in the harvest job', () => {
    const doc = parseYaml(yml());
    const jobs = Object.entries(doc.jobs);
    const owning = jobs.filter(([, job]) => (job.steps || []).some((s) => s.name === STEP));
    assert.equal(owning.length, 1, 'the step must exist in exactly one job');
    const [jobName, job] = owning[0];
    assert.ok((job.steps || []).some((s) => String(s.run || '').includes(CLI)),
        `the step in job ${jobName} must invoke ${CLI}`);
});

test('G2 the CLI the workflow names actually exists and is the entry point', () => {
    const file = path.join(ROOT, CLI);
    assert.ok(fs.existsSync(file), `${CLI} must exist -- a workflow naming a missing file is a dead path`);
    const src = fs.readFileSync(file, 'utf8');
    assert.ok(src.includes("from './lib/registry-renorm-run.js'"), 'the CLI must delegate to the run module');
    assert.ok(src.includes('op-gr-b-giant-cohort.json'), 'the CLI must load the embedded census');
});

test('G2b the CLI routes its exit code through the pinned predicate', () => {
    // Call-site pin: R9b proves exitCodeFor() is correct, but only this proves
    // the CLI actually uses it. An inlined ternary here would be untested.
    const src = fs.readFileSync(path.join(ROOT, CLI), 'utf8');
    assert.ok(src.includes('process.exit(exitCodeFor(result.outcome));'),
        'the CLI must exit via exitCodeFor(), not via an inline comparison');
    assert.equal(/process\.exit\(\s*result\.outcome\s*===/.test(src), false,
        'no inline exit-code comparison may remain');
});

test('G3 both steps are gated on the flag AND on a schedule event', () => {
    const doc = parseYaml(yml());
    const steps = Object.values(doc.jobs).flatMap((j) => j.steps || []);
    const main = steps.find((s) => s.name === STEP);
    const upload = steps.find((s) => s.name === UPLOAD_STEP);

    // Exact expressions. The flag alone is NOT sufficient: this workflow also
    // has workflow_dispatch, so a flag-only gate leaves the one-time operation
    // manually reachable, which the ruling forbids.
    assert.equal(main.if, `vars.${FLAG} == 'true' && ${SCHEDULE}`,
        'the renorm step must require the repo variable AND a schedule event');
    assert.equal(upload.if, `always() && vars.${FLAG} == 'true' && ${SCHEDULE}`,
        'the upload must carry always() AND both gates, in that order');
    assert.ok(String(upload.if).startsWith('always()'),
        'always() must lead so an abandoned/failed SCHEDULED run still ships its pre-image');
});

test('G3b the gates compose correctly across the four reachable event/flag cases', () => {
    const doc = parseYaml(yml());
    const steps = Object.values(doc.jobs).flatMap((j) => j.steps || []);
    // Evaluate the real `if:` strings as booleans for each case. This is a
    // truth table over the actual expressions, not a restatement of them.
    const evaluate = (expr, { event, flag, failed }) => {
        const js = expr
            .replace(/always\(\)/g, String(true))
            .replace(/github\.event_name/g, JSON.stringify(event))
            .replace(new RegExp(`vars\\.${FLAG}`, 'g'), JSON.stringify(flag))
            .replace(/ == /g, ' === ');
        void failed;
        return Function(`"use strict";return (${js});`)();
    };
    for (const stepName of [STEP, UPLOAD_STEP]) {
        const expr = steps.find((s) => s.name === stepName).if;
        assert.equal(evaluate(expr, { event: 'schedule', flag: 'true' }), true,
            `${stepName}: scheduled + flag set must RUN`);
        assert.equal(evaluate(expr, { event: 'workflow_dispatch', flag: 'true' }), false,
            `${stepName}: MANUAL DISPATCH must never run it, even with the flag set`);
        assert.equal(evaluate(expr, { event: 'schedule', flag: '' }), false,
            `${stepName}: scheduled without the flag must not run`);
        assert.equal(evaluate(expr, { event: 'workflow_dispatch', flag: '' }), false,
            `${stepName}: neither condition met must not run`);
    }
});

test('G4 the event-name guard is present and no dispatch input can drive the flag', () => {
    const text = yml();
    // The workflow really does offer workflow_dispatch -- that is precisely why
    // the guard is required rather than optional.
    assert.ok(text.includes('workflow_dispatch:'),
        'anti-vacuity: if this workflow ever loses workflow_dispatch, re-derive the guard rationale');
    const guards = [...text.matchAll(/github\.event_name == 'schedule'/g)];
    assert.equal(guards.length, 2, 'exactly the two OP-GR-B steps must carry the event-name guard');
    assert.equal(/github\.event\.inputs\.[a-z_]*op_gr_b/i.test(text), false,
        'the ruling replaced any dispatch design with a repo variable + natural cascade');
    assert.equal(text.includes(`inputs.${FLAG}`), false);
});

test('G5 LINE ORDER: after the registry is loaded, before the first consumer', () => {
    const text = yml();
    const cacheRestore = lineOf(text, 'key: global-registry-${{ github.run_id }}');
    const r2Restore = lineOf(text, 'node scripts/factory/lib/r2-registry-restore.js');
    const renorm = lineOf(text, `- name: ${STEP}`);
    const mergeBatches = lineOf(text, 'node scripts/ingestion/merge-batches.js');

    assert.ok(cacheRestore < r2Restore,
        'GHA-cache restore must precede the R2 restore (existing precedence, untouched)');
    assert.ok(r2Restore < renorm,
        'the re-normalisation must run AFTER the registry is fully loaded');
    assert.ok(renorm < mergeBatches,
        'the re-normalisation must run BEFORE merge-batches.js consumes the registry');
});

test('G6 the restore/precedence logic this PR must NOT touch is intact', () => {
    const text = yml();
    // Cache-first with a prefix restore-key, then R2 as a gap-filler. If a
    // future edit changes precedence in the same breath as washing data, this
    // pin goes RED -- the ruling forbids aliasing those two variables.
    assert.ok(text.includes('restore-keys: |\n            global-registry-'),
        'the cache-first prefix restore-key must remain');
    assert.ok(text.includes('node scripts/factory/lib/r2-registry-restore.js'),
        'the R2 gap-filler restore must remain');
    const restoreStep = text.indexOf('- name: R2 Registry Restoration (V25.8)');
    const renormStep = text.indexOf(`- name: ${STEP}`);
    assert.ok(restoreStep > 0 && renormStep > restoreStep,
        'the new step must be ADDED after the restore, not replace it');
});

test('G7 the step runs with headroom for one giant record parse', () => {
    const text = yml();
    const at = text.indexOf(`- name: ${STEP}`);
    const body = text.slice(at, text.indexOf('- name: ', at + 10));
    assert.match(body, /--max-old-space-size=\d+/,
        'a 311 MB record parses to ~3x on the heap; the step must raise old-space explicitly');
    assert.ok(body.includes('AES_CRYPTO_KEY: ${{ secrets.AES_CRYPTO_KEY }}'),
        'the key must come from the secret store and nowhere else');
    assert.equal(/AES_CRYPTO_KEY:\s*['"][0-9a-fA-F]/.test(body), false,
        'no literal key may ever appear in the workflow');
});

test('G9 the PRODUCTION step must NEVER carry --reconcile-only', () => {
    // THE DANGEROUS INVERSE of the CLI-forwarding pin. `--reconcile-only` makes
    // runRenorm stop at the manifest, so if it ever reached the ARMED production
    // step the wash would become a silent, permanent no-op: it would scan, write
    // a manifest, report RECONCILED and exit 0 while repairing NOTHING -- and
    // because no completion marker is written, the flag stays armed and every
    // subsequent cycle repeats the same green nothing, indefinitely. A green CI
    // run would look identical to a successful repair.
    const text = yml();
    const at = text.indexOf(`- name: ${STEP}`);
    assert.ok(at > 0, 'the production step must exist');
    const body = text.slice(at, text.indexOf('- name: ', at + 10));
    assert.match(body, /node .*registry-renorm-cli\.js/, 'anti-vacuity: the slice must contain the CLI invocation');
    assert.equal(/--reconcile-only/.test(body), false,
        'the production OP-GR-B step must never run in reconcile-only mode');
    // The rehearsal lane owns that flag; production must not mention it at all.
    assert.equal(/--reconcile-only/.test(text), false,
        'factory-harvest.yml must not reference --reconcile-only anywhere');
});

test('G8 every new .test.mjs in this PR is registered in the required node --test list', () => {
    const suite = fs.readFileSync(TEST_SUITE_YML, 'utf8').replace(/\r\n/g, '\n');
    for (const f of [
        'scripts/factory/registry-renorm-core.test.mjs',
        'scripts/factory/registry-renorm-shard.test.mjs',
        'scripts/factory/registry-renorm-run.test.mjs',
        'scripts/factory/registry-renorm-verification.test.mjs',
        'scripts/factory/registry-renorm-census.test.mjs',
        'scripts/factory/registry-stale-shard-purge.test.mjs',
        'scripts/factory/rehearsal-reconcile.test.mjs',
        'scripts/factory/registry-renorm-wiring.test.mjs',
        'scripts/ingestion/producer-compound-failure.test.mjs',
    ]) {
        assert.ok(suite.includes(f), `${f} must be in the required unit-test list or it is not a gate`);
    }
});
