// scripts/ci/alert-notification-matrix.test.mjs
//
// Hermetic node:test suite for the Factory alert notification matrix (Defect 2 of
// the 2026-07-26 Factory 1/4 S2 incident). NO network, NO notification of any kind
// is sent by this suite or by the module it tests -- the module is pure and returns
// a decision object; only .github/workflows/infra-alert.yml ever routes anything.
//
// It asserts three things the incident showed were unasserted:
//   1. all four Factory workflows are covered, by their EXACT `name:` strings read
//      from their own workflow files (name-string drift is the classic silent
//      failure for a `workflow_run` trigger);
//   2. the full matrix over failure / timed_out / cancelled;
//   3. that a deliberate cancellation is never presented as a failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    classifyAlert, toOutputLines, baseSeverity, isFactoryWorkflow,
    FACTORY_WORKFLOW_NAMES, LEGACY_WORKFLOW_NAMES, COVERED_WORKFLOW_NAMES,
    ALERTING_CONCLUSIONS, ALERT_CLASS, SEVERITY, CANCELLATION_ORIGIN, cancellationOrigin,
} from './alert-notification-matrix.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WF = (f) => path.join(REPO, '.github', 'workflows', f);

/** The workflow FILE -> the `name:` value the alert list must match. */
const FACTORY_FILES = [
    ['factory-harvest.yml', 'Factory 1/4 - Harvest'],
    ['factory-process.yml', 'Factory 2/4 - Process'],
    ['factory-aggregate.yml', 'Factory 3/4 - Aggregate'],
    ['factory-upload.yml', 'Factory 4/4 - Finalize'],
];

function firstNameDirective(file) {
    const text = fs.readFileSync(WF(file), 'utf8');
    const line = text.split(/\r?\n/).find((l) => l.startsWith('name:'));
    assert.ok(line, `${file} has no top-level name: directive`);
    return line.slice('name:'.length).trim().replace(/^["']|["']$/g, '');
}

/**
 * Extract the EXACT `on.workflow_run.workflows` list from infra-alert.yml.
 *
 * WHOLE-FILE SUBSTRING MATCHING IS FORBIDDEN HERE. `yml.includes('"Factory 1/4 -
 * Harvest"')` is satisfied by the name appearing in a COMMENT, so it would pass even
 * if the trigger list were empty -- i.e. it would pass in exactly the state this
 * whole repair exists to prevent. This walks the real structure instead: `on:` ->
 * `workflow_run:` -> `workflows:` -> the quoted list items, stopping at the next key
 * at the same or lower indentation. Comment lines are skipped, never collected.
 */
function triggerWorkflowsList() {
    const lines = fs.readFileSync(WF('infra-alert.yml'), 'utf8').replace(/\r\n/g, '\n').split('\n');
    const onIdx = lines.findIndex((l) => /^on:\s*$/.test(l));
    assert.ok(onIdx >= 0, 'infra-alert.yml has no top-level `on:` block');

    let wrIdx = -1;
    for (let i = onIdx + 1; i < lines.length; i++) {
        if (/^\S/.test(lines[i])) break;                     // left the `on:` block
        if (/^ {2}workflow_run:\s*$/.test(lines[i])) { wrIdx = i; break; }
    }
    assert.ok(wrIdx >= 0, 'infra-alert.yml has no on.workflow_run trigger');

    let wfIdx = -1;
    for (let i = wrIdx + 1; i < lines.length; i++) {
        if (/^ {0,2}\S/.test(lines[i])) break;               // left workflow_run
        if (/^ {4}workflows:\s*$/.test(lines[i])) { wfIdx = i; break; }
    }
    assert.ok(wfIdx >= 0, 'on.workflow_run has no `workflows:` list');

    const items = [];
    for (let i = wfIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*#/.test(line)) continue;                    // comments are NOT data
        if (/^\s*$/.test(line)) continue;
        const m = line.match(/^ {6}- *["']?(.*?)["']?\s*$/);
        if (m) { items.push(m[1]); continue; }
        break;                                               // next key -> list ended
    }
    return items;
}

/** The exact conclusion set the job-level `if:` gate admits, parsed from its JSON. */
function gateConclusions() {
    const yml = fs.readFileSync(WF('infra-alert.yml'), 'utf8');
    const m = yml.match(/fromJSON\('(\[[^']*\])'\)/);
    assert.ok(m, 'infra-alert.yml job gate does not use a fromJSON conclusion list');
    return JSON.parse(m[1]);
}

// ---------------------------------------------------------------------------
// 1. COVERAGE -- read each name from its OWN file; never guess from the filename.
// ---------------------------------------------------------------------------

test('each Factory workflow file declares the exact name the matrix claims', () => {
    for (const [file, expected] of FACTORY_FILES) {
        assert.equal(firstNameDirective(file), expected, `${file} name drift`);
    }
});

test('the matrix covers all four Factory stages plus the pre-existing three', () => {
    for (const [, expected] of FACTORY_FILES) {
        assert.ok(FACTORY_WORKFLOW_NAMES.includes(expected), `not covered: ${expected}`);
        assert.ok(COVERED_WORKFLOW_NAMES.includes(expected), `not in covered list: ${expected}`);
        assert.equal(isFactoryWorkflow(expected), true);
    }
    assert.equal(FACTORY_WORKFLOW_NAMES.length, 4);
    for (const legacy of LEGACY_WORKFLOW_NAMES) {
        assert.ok(COVERED_WORKFLOW_NAMES.includes(legacy), `regressed legacy coverage: ${legacy}`);
    }
    assert.equal(COVERED_WORKFLOW_NAMES.length, 7);
});

test('4/4 is "Finalize", not "Upload" -- the filename is not the workflow name', () => {
    assert.ok(FACTORY_WORKFLOW_NAMES.includes('Factory 4/4 - Finalize'));
    assert.ok(!FACTORY_WORKFLOW_NAMES.includes('Factory 4/4 - Upload'));
    assert.equal(isFactoryWorkflow('Factory 4/4 - Upload'), false);
});

test('the EXACT on.workflow_run.workflows list equals the covered set (no substring matching)', () => {
    const declared = triggerWorkflowsList();
    // Exact list-item equality, order-independent. A name present ONLY in a comment
    // cannot satisfy this, which is the entire point.
    assert.deepEqual([...declared].sort(), [...COVERED_WORKFLOW_NAMES].sort());
    for (const [, expected] of FACTORY_FILES) {
        assert.ok(declared.includes(expected), `trigger list is missing: ${expected}`);
    }
    assert.equal(declared.length, 7);
});

test('the job gate admits EXACTLY failure / timed_out / cancelled', () => {
    assert.deepEqual(gateConclusions().sort(), [...ALERTING_CONCLUSIONS].sort());
});

test('infra-alert.yml wires the matrix and gates both senders on notify', () => {
    const yml = fs.readFileSync(WF('infra-alert.yml'), 'utf8');
    assert.ok(yml.includes('node scripts/ci/alert-notification-matrix.mjs'));
    assert.match(yml, /Send Slack Notification[\s\S]{0,200}steps\.matrix\.outputs\.notify == 'true'/);
    assert.match(yml, /Send Email Notification[\s\S]{0,200}steps\.matrix\.outputs\.notify == 'true'/);
    // The replaced inline bash severity step must be gone (no double source of truth).
    assert.ok(!yml.includes('steps.severity.outputs.'), 'stale severity-step references remain');
    // The removed `deliberate` output must not be resurrected in the yml either.
    assert.ok(!yml.includes('outputs.deliberate'), 'stale `deliberate` output reference remains');
});

test('the extractor ignores comments -- a comment-only name is NOT collected', () => {
    // Guards the guard, so the mutation "delete from the list but leave the identical
    // string in a comment" is genuinely caught rather than accidentally passing.
    const declared = triggerWorkflowsList();
    assert.ok(declared.every((n) => n.trim().length > 0 && !n.startsWith('#')));
    const raw = fs.readFileSync(WF('infra-alert.yml'), 'utf8');
    assert.ok(/^\s*#/m.test(raw.split('types:')[0]), 'expected comments inside the on: block');
});

test('an unknown workflow name is never silently alerted on', () => {
    const d = classifyAlert({ workflowName: 'Factory 5/4 - Imaginary', conclusion: 'failure', event: 'schedule' });
    assert.equal(d.covered, false);
    assert.equal(d.notify, false);
});

// ---------------------------------------------------------------------------
// 2. THE MATRIX
// ---------------------------------------------------------------------------

// workflow, conclusion, upstream event, class, severity, notify, page, cancellation_origin
const MATRIX = [
    ['Factory 1/4 - Harvest', 'failure', 'schedule', 'FAILURE', 'HIGH', true, true, ''],
    ['Factory 1/4 - Harvest', 'timed_out', 'schedule', 'TIMEOUT', 'HIGH', true, true, ''],
    ['Factory 2/4 - Process', 'failure', 'workflow_run', 'FAILURE', 'HIGH', true, true, ''],
    ['Factory 3/4 - Aggregate', 'timed_out', 'workflow_run', 'TIMEOUT', 'HIGH', true, true, ''],
    ['Factory 4/4 - Finalize', 'failure', 'workflow_run', 'FAILURE', 'HIGH', true, true, ''],
    ['Infra Deploy', 'failure', 'push', 'FAILURE', 'HIGH', true, true, ''],
    ['L3 Guardian - Weekly Maintenance', 'failure', 'schedule', 'FAILURE', 'MEDIUM', true, true, ''],

    // MANDATORY CANCELLATION ROWS. The whole cascade must alert on a cancellation:
    // 1/4 is triggered by `schedule`, but 2/4, 3/4 and 4/4 are `workflow_run`. The
    // previous `event === 'schedule'` classifier silenced three of the four stages
    // AND labelled them "deliberate" -- an unevidenced claim about a later event.
    ['Factory 1/4 - Harvest', 'cancelled', 'schedule', 'CANCELLED', 'MEDIUM', true, false, 'automatic'],
    ['Factory 2/4 - Process', 'cancelled', 'workflow_run', 'CANCELLED', 'MEDIUM', true, false, 'automatic'],
    ['Factory 3/4 - Aggregate', 'cancelled', 'workflow_run', 'CANCELLED', 'MEDIUM', true, false, 'automatic'],
    ['Factory 4/4 - Finalize', 'cancelled', 'workflow_run', 'CANCELLED', 'MEDIUM', true, false, 'automatic'],
    ['Factory 1/4 - Harvest', 'cancelled', 'workflow_dispatch', 'CANCELLED', 'LOW', false, false, 'manual_origin'],
    ['Infra Deploy', 'cancelled', 'some_future_event', 'CANCELLED', 'MEDIUM', true, false, 'unknown'],
    ['Factory 4/4 - Finalize', 'cancelled', undefined, 'CANCELLED', 'MEDIUM', true, false, 'unknown'],
    ['Factory 4/4 - Finalize', 'cancelled', 'push', 'CANCELLED', 'MEDIUM', true, false, 'automatic'],

    ['Factory 1/4 - Harvest', 'success', 'schedule', 'NONE', 'LOW', false, false, ''],
    ['Factory 1/4 - Harvest', 'skipped', 'schedule', 'NONE', 'LOW', false, false, ''],
    ['Factory 1/4 - Harvest', 'neutral', 'schedule', 'NONE', 'LOW', false, false, ''],
];

for (const [workflowName, conclusion, event, cls, sev, notify, page, origin] of MATRIX) {
    test(`matrix: ${workflowName} / ${conclusion} / ${event} -> ${cls} ${sev} notify=${notify} origin=${origin || 'n/a'}`, () => {
        const d = classifyAlert({ workflowName, conclusion, event });
        assert.equal(d.alert_class, cls);
        assert.equal(d.severity, sev);
        assert.equal(d.level, sev);
        assert.equal(d.notify, notify);
        assert.equal(d.page, page);
        assert.equal(d.cancellation_origin, origin);
        assert.equal(d.create_issue, false);
        // The removed `deliberate` boolean must never come back.
        assert.equal(Object.prototype.hasOwnProperty.call(d, 'deliberate'), false);
    });
}

test('EVERY Factory stage alerts on cancellation, including the workflow_run cascade', () => {
    // The regression the old classifier caused, pinned directly: three of four stages
    // silent. If any stage stops notifying, this fails regardless of the table above.
    const events = { 'Factory 1/4 - Harvest': 'schedule' };
    for (const name of FACTORY_WORKFLOW_NAMES) {
        const d = classifyAlert({ workflowName: name, conclusion: 'cancelled', event: events[name] || 'workflow_run' });
        assert.equal(d.notify, true, `${name} does not alert on cancellation`);
        assert.equal(d.alert_class, ALERT_CLASS.CANCELLED);
        assert.equal(d.cancellation_origin, CANCELLATION_ORIGIN.AUTOMATIC);
    }
});

test('cancellationOrigin maps every documented event, and fails open to unknown', () => {
    assert.equal(cancellationOrigin('schedule'), CANCELLATION_ORIGIN.AUTOMATIC);
    assert.equal(cancellationOrigin('workflow_run'), CANCELLATION_ORIGIN.AUTOMATIC);
    assert.equal(cancellationOrigin('push'), CANCELLATION_ORIGIN.AUTOMATIC);
    assert.equal(cancellationOrigin('workflow_dispatch'), CANCELLATION_ORIGIN.MANUAL_ORIGIN);
    assert.equal(cancellationOrigin(undefined), CANCELLATION_ORIGIN.UNKNOWN);
    assert.equal(cancellationOrigin(''), CANCELLATION_ORIGIN.UNKNOWN);
    assert.equal(cancellationOrigin('repository_dispatch'), CANCELLATION_ORIGIN.UNKNOWN);
});

test('the three alerting conclusions are exactly failure / timed_out / cancelled', () => {
    assert.deepEqual([...ALERTING_CONCLUSIONS], ['failure', 'timed_out', 'cancelled']);
});

// ---------------------------------------------------------------------------
// 3. CANCELLED IS NEVER COLLAPSED INTO FAILURE
// ---------------------------------------------------------------------------

test('cancelled never carries a FAILURE class, a failure noun, or a failure prefix', () => {
    for (const event of ['schedule', 'workflow_dispatch', 'push', 'workflow_run', 'nonsense', undefined]) {
        const d = classifyAlert({ workflowName: 'Factory 1/4 - Harvest', conclusion: 'cancelled', event });
        assert.equal(d.alert_class, ALERT_CLASS.CANCELLED);
        assert.notEqual(d.alert_class, ALERT_CLASS.FAILURE);
        assert.notEqual(d.alert_class, ALERT_CLASS.TIMEOUT);
        assert.equal(d.subject_prefix, '[CANCELLED]');
        assert.equal(d.outcome_noun, 'Cancelled');
        assert.equal(d.page, false);          // never pages the channel
        assert.equal(d.create_issue, false);  // never opens an incident issue
        assert.ok(!/\bfailed\b/i.test(d.action_text), `action text implies failure: ${d.action_text}`);
        assert.ok(!d.action_text.includes('<!channel>'), 'a cancellation must not page');
        assert.ok(/cancellation/i.test(d.action_text), `action text must name the cancellation: ${d.action_text}`);
    }
});

test('NO cancellation text claims the cancellation was deliberate or proven', () => {
    for (const event of ['schedule', 'workflow_dispatch', 'push', 'workflow_run', 'nonsense', undefined]) {
        const d = classifyAlert({ workflowName: 'Factory 1/4 - Harvest', conclusion: 'cancelled', event });
        assert.ok(!/deliberate/i.test(d.action_text), `claims deliberate: ${d.action_text}`);
        assert.ok(!/manually triggered/i.test(d.action_text), `claims manual trigger: ${d.action_text}`);
        // Every variant must state that the cause is not established.
        assert.ok(/NOT proven|UNKNOWN/.test(d.action_text), `does not disclaim the cause: ${d.action_text}`);
    }
});

test('an automatic-origin cancellation is never described as manually triggered', () => {
    for (const event of ['schedule', 'workflow_run', 'push']) {
        const d = classifyAlert({ workflowName: 'Factory 2/4 - Process', conclusion: 'cancelled', event });
        assert.equal(d.cancellation_origin, CANCELLATION_ORIGIN.AUTOMATIC);
        assert.ok(!/manual/i.test(d.action_text), `automatic run described as manual: ${d.action_text}`);
        assert.equal(d.notify, true);
    }
});

test('a manual-ORIGIN cancellation says only that the RUN had manual origin', () => {
    const d = classifyAlert({ workflowName: 'Factory 1/4 - Harvest', conclusion: 'cancelled', event: 'workflow_dispatch' });
    assert.equal(d.cancellation_origin, CANCELLATION_ORIGIN.MANUAL_ORIGIN);
    assert.equal(d.notify, false);
    assert.equal(d.severity, SEVERITY.LOW);
    assert.match(d.action_text, /manual origin/i);
    assert.ok(!/deliberate/i.test(d.action_text));
});

test('an UNKNOWN-origin cancellation notifies and says the cause is unknown', () => {
    const d = classifyAlert({ workflowName: 'Infra Deploy', conclusion: 'cancelled', event: 'repository_dispatch' });
    assert.equal(d.cancellation_origin, CANCELLATION_ORIGIN.UNKNOWN);
    assert.equal(d.notify, true);
    assert.equal(d.page, false);
    assert.equal(d.create_issue, false);
    assert.match(d.action_text, /UNKNOWN/);
});

test('timed_out is its own class -- not folded into FAILURE and not into CANCELLED', () => {
    const t = classifyAlert({ workflowName: 'Factory 1/4 - Harvest', conclusion: 'timed_out', event: 'schedule' });
    const f = classifyAlert({ workflowName: 'Factory 1/4 - Harvest', conclusion: 'failure', event: 'schedule' });
    const c = classifyAlert({ workflowName: 'Factory 1/4 - Harvest', conclusion: 'cancelled', event: 'schedule' });
    assert.equal(t.alert_class, ALERT_CLASS.TIMEOUT);
    assert.notEqual(t.alert_class, f.alert_class);
    assert.notEqual(t.alert_class, c.alert_class);
    assert.notEqual(t.subject_prefix, f.subject_prefix);
    assert.notEqual(t.subject_prefix, c.subject_prefix);
    assert.notEqual(t.emoji, f.emoji);
    assert.notEqual(t.emoji, c.emoji);
});

// ---------------------------------------------------------------------------
// 4. PRESERVED PRE-EXISTING RULES + OUTPUT SHAPE
// ---------------------------------------------------------------------------

test('pre-existing severity rules are preserved (Backup CRITICAL, Deploy HIGH, else MEDIUM)', () => {
    assert.equal(baseSeverity('Nightly Backup'), SEVERITY.CRITICAL);
    assert.equal(baseSeverity('Infra Deploy'), SEVERITY.HIGH);
    assert.equal(baseSeverity('Something Else'), SEVERITY.MEDIUM);
    assert.equal(baseSeverity('Factory 3/4 - Aggregate'), SEVERITY.HIGH);
});

test('create_issue is reserved for a covered CRITICAL failure, never a cancellation', () => {
    assert.equal(classifyAlert({ workflowName: 'Factory 1/4 - Harvest', conclusion: 'failure', event: 'schedule' }).create_issue, false);
    assert.equal(classifyAlert({ workflowName: 'Infra Deploy', conclusion: 'failure', event: 'push' }).create_issue, false);
});

test('toOutputLines emits GITHUB_OUTPUT key=value pairs with lower-case booleans', () => {
    const lines = toOutputLines(classifyAlert({ workflowName: 'Factory 1/4 - Harvest', conclusion: 'failure', event: 'schedule' })).split('\n');
    assert.ok(lines.includes('alert_class=FAILURE'));
    assert.ok(lines.includes('notify=true'));
    assert.ok(lines.includes('level=HIGH'));
    assert.ok(lines.includes('cancellation_origin='));
    assert.ok(!lines.some((l) => l.startsWith('deliberate=')));
    for (const l of lines) assert.match(l, /^[a-z_]+=/, `malformed output line: ${l}`);
});

test('a missing/undefined conclusion is inert (no notification, no class)', () => {
    const d = classifyAlert({});
    assert.equal(d.alert_class, ALERT_CLASS.NONE);
    assert.equal(d.notify, false);
});
