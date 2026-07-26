// scripts/ci/alert-notification-matrix.mjs
//
// THE FACTORY ALERT NOTIFICATION MATRIX -- one pure function that decides what an
// upstream `workflow_run` completion means, plus a tiny CLI that emits the decision
// as GITHUB_OUTPUT lines for .github/workflows/infra-alert.yml.
//
// WHY IT EXISTS (Defect 2 of the 2026-07-26 Factory 1/4 S2 incident). Factory 1/4
// failed on a natural cron (run 30189935455) and NOTHING alerted: infra-alert.yml
// listened only to "Infra Deploy", "L1 Harvester - Daily Data Ingestion" and
// "L3 Guardian - Weekly Maintenance". Factory 1/4 was absent and 2/4-4/4 were not
// covered at all. It also fired only on `conclusion == 'failure'`, so a timed-out
// or cancelled Factory run was silent by construction.
//
// WHY THE LOGIC IS HERE AND NOT IN BASH. A `workflows:` list matches upstream runs
// by their EXACT `name:` string, so a one-character drift silently disables the
// alert with no error anywhere -- the classic failure mode for this file. Putting
// the covered-name list and the conclusion matrix in a module makes both directly
// testable: scripts/ci/alert-notification-matrix.test.mjs (the blocking guard, run
// from the `node --test` list in .github/workflows/test-suite.yml) both asserts the
// matrix AND re-reads each Factory workflow's own `name:` from its own file, then
// matches it against the EXACT parsed `on.workflow_run.workflows` list in the yml --
// never a whole-file substring, which a name sitting in a comment would satisfy while
// the trigger list was empty.
//
// CANCELLATION IS NEVER COLLAPSED INTO FAILURE, AND ITS CAUSE IS NEVER CLAIMED.
// `cancelled` gets its own alert class, subject prefix and severity floor; it never
// pages, never opens an issue, and is never described as a failure. What this module
// does NOT do is infer intent from the trigger event: it classifies ORIGIN only
// (automatic / manual_origin / unknown) and states in every case that the
// cancellation cause is not proven. See CANCELLATION_ORIGIN below for why the earlier
// `event === 'schedule'` test was wrong for this cascade.
//
// Node built-ins only. No network. This module never sends anything.

/** EXACT `name:` values of the Factory workflows, verified against each file. */
export const FACTORY_WORKFLOW_NAMES = Object.freeze([
    'Factory 1/4 - Harvest',    // .github/workflows/factory-harvest.yml
    'Factory 2/4 - Process',    // .github/workflows/factory-process.yml
    'Factory 3/4 - Aggregate',  // .github/workflows/factory-aggregate.yml
    'Factory 4/4 - Finalize',   // .github/workflows/factory-upload.yml  <-- NOT "Upload"
]);

/** Pre-existing coverage, retained verbatim. */
export const LEGACY_WORKFLOW_NAMES = Object.freeze([
    'Infra Deploy',
    'L1 Harvester - Daily Data Ingestion',
    'L3 Guardian - Weekly Maintenance',
]);

/** The complete `workflows:` list infra-alert.yml must declare. */
export const COVERED_WORKFLOW_NAMES = Object.freeze([
    ...LEGACY_WORKFLOW_NAMES, ...FACTORY_WORKFLOW_NAMES,
]);

/** The only conclusions this alert reacts to. Everything else is NONE. */
export const ALERTING_CONCLUSIONS = Object.freeze(['failure', 'timed_out', 'cancelled']);

export const ALERT_CLASS = Object.freeze({
    FAILURE: 'FAILURE', TIMEOUT: 'TIMEOUT', CANCELLED: 'CANCELLED', NONE: 'NONE',
});

export const SEVERITY = Object.freeze({
    CRITICAL: 'CRITICAL', HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW',
});

const CLASS_BY_CONCLUSION = Object.freeze({
    failure: ALERT_CLASS.FAILURE,
    timed_out: ALERT_CLASS.TIMEOUT,
    cancelled: ALERT_CLASS.CANCELLED,
});

const PRESENTATION = Object.freeze({
    [ALERT_CLASS.FAILURE]: { emoji: '\u{1F6A8}', color: '#FF0000', prefix: '[FAILED]', noun: 'Failed' },
    [ALERT_CLASS.TIMEOUT]: { emoji: '\u{23F1}', color: '#FF6A00', prefix: '[TIMED OUT]', noun: 'Timed Out' },
    [ALERT_CLASS.CANCELLED]: { emoji: '\u{26D4}', color: '#808080', prefix: '[CANCELLED]', noun: 'Cancelled' },
    [ALERT_CLASS.NONE]: { emoji: '', color: '#000000', prefix: '', noun: '' },
});

/**
 * How the CANCELLED run ORIGINATED. This is deliberately NOT a claim about who
 * cancelled it: `github.event.workflow_run.event` records how the run started, and a
 * run started any way at all can be cancelled by a human, by concurrency eviction, or
 * by a runner going away. Only the origin is knowable here, so only the origin is
 * stated.
 *
 * VERIFIED CASCADE ORIGINS (why the previous `event === 'schedule'` test was wrong):
 * Factory 1/4 is `schedule`, but 2/4, 3/4 and 4/4 are `workflow_run` -- so treating
 * anything non-`schedule` as a human's own run silenced three of the four cascade
 * stages AND described their cancellation as "deliberate", which was never evidenced.
 */
export const CANCELLATION_ORIGIN = Object.freeze({
    AUTOMATIC: 'automatic',
    MANUAL_ORIGIN: 'manual_origin',
    UNKNOWN: 'unknown',
});

const ORIGIN_BY_EVENT = Object.freeze({
    schedule: CANCELLATION_ORIGIN.AUTOMATIC,      // Factory 1/4
    workflow_run: CANCELLATION_ORIGIN.AUTOMATIC,  // Factory 2/4, 3/4, 4/4
    push: CANCELLATION_ORIGIN.AUTOMATIC,
    workflow_dispatch: CANCELLATION_ORIGIN.MANUAL_ORIGIN,
});

/** Action text per origin. None of these asserts an unproven cancellation cause. */
const CANCELLATION_TEXT = Object.freeze({
    [CANCELLATION_ORIGIN.AUTOMATIC]:
        'Cancellation of an automatically triggered run. No failure asserted. '
        + 'The cancellation cause is NOT proven; confirm whether the cycle must be re-run.',
    [CANCELLATION_ORIGIN.MANUAL_ORIGIN]:
        'Cancellation of a run that had manual origin (workflow_dispatch). No failure '
        + 'asserted. The cancellation cause is NOT proven.',
    [CANCELLATION_ORIGIN.UNKNOWN]:
        'Cancellation of a run whose trigger origin is UNKNOWN. No failure asserted. '
        + 'The cancellation cause is UNKNOWN and NOT proven; investigate.',
});

/** Map the upstream trigger event to an origin. Unrecognised/missing -> unknown. */
export function cancellationOrigin(event) {
    return ORIGIN_BY_EVENT[event] || CANCELLATION_ORIGIN.UNKNOWN;
}

/** True for the four Factory pipeline stages (1/4 - 4/4). */
export function isFactoryWorkflow(workflowName) {
    return FACTORY_WORKFLOW_NAMES.includes(workflowName);
}

/**
 * Severity for a FAILING/TIMED-OUT run, by workflow identity. Backup and Deploy
 * keep their pre-existing rules; the Factory stages are HIGH because 1/4-4/4 gate
 * the whole daily cascade -- a silent Factory stop is exactly what this repair is
 * about. Everything unknown stays MEDIUM, as before.
 */
export function baseSeverity(workflowName) {
    const name = String(workflowName || '');
    if (name.includes('Backup')) return SEVERITY.CRITICAL;
    if (name.includes('Deploy')) return SEVERITY.HIGH;
    if (isFactoryWorkflow(name)) return SEVERITY.HIGH;
    return SEVERITY.MEDIUM;
}

/**
 * THE MATRIX. Pure: same inputs -> same decision, no clock, no network, no env.
 *
 * @param {Object} ev
 * @param {string} ev.workflowName - github.event.workflow_run.name
 * @param {string} ev.conclusion   - github.event.workflow_run.conclusion
 * @param {string} ev.event        - github.event.workflow_run.event (the UPSTREAM trigger)
 * @returns {Object} decision
 */
export function classifyAlert({ workflowName, conclusion, event } = {}) {
    const alertClass = CLASS_BY_CONCLUSION[conclusion] || ALERT_CLASS.NONE;
    const covered = COVERED_WORKFLOW_NAMES.includes(workflowName);
    const view = PRESENTATION[alertClass];

    if (alertClass === ALERT_CLASS.NONE) {
        return decision({ alertClass, view, severity: SEVERITY.LOW, notify: false, covered });
    }

    if (alertClass === ALERT_CLASS.CANCELLED) {
        // A cancellation asserts NO failure -- and, critically, the trigger origin does
        // NOT reveal who cancelled the run or why. `workflow_dispatch` proves only that
        // the RUN originated through dispatch; it proves nothing about the cancellation
        // that happened later. So this branch classifies ORIGIN and says only what the
        // event field actually supports. The cause is never claimed as proven.
        const origin = cancellationOrigin(event);
        const manual = origin === CANCELLATION_ORIGIN.MANUAL_ORIGIN;
        return decision({
            alertClass, view, covered, cancellationOrigin: origin,
            severity: manual ? SEVERITY.LOW : SEVERITY.MEDIUM,
            notify: covered && !manual,
            actionText: CANCELLATION_TEXT[origin],
        });
    }

    // FAILURE and TIMEOUT: both page, and both stay distinct from each other.
    const severity = baseSeverity(workflowName);
    return decision({
        alertClass, view, covered, severity,
        notify: covered,
        page: covered,
        createIssue: covered && severity === SEVERITY.CRITICAL,
        actionText: '<!channel> Action required!',
    });
}

function decision({
    alertClass, view, severity, notify, covered,
    page = false, createIssue = false, actionText = '',
    // Only meaningful for CANCELLED. The former `deliberate` boolean was REMOVED
    // rather than retained for compatibility: it asserted an intent the event field
    // cannot evidence, and its only consumer was this workflow's own presentation.
    cancellationOrigin: origin = '',
}) {
    return {
        alert_class: alertClass,
        severity,
        level: severity,          // retained key name: the yml's pre-existing `level`.
        emoji: view.emoji,
        color: view.color,
        subject_prefix: view.prefix,
        outcome_noun: view.noun,
        covered,
        notify,
        page,
        create_issue: createIssue,
        cancellation_origin: origin,
        action_text: actionText,
    };
}

/** Render the decision as GITHUB_OUTPUT `key=value` lines (booleans lower-cased). */
export function toOutputLines(d) {
    return Object.entries(d)
        .map(([k, v]) => `${k}=${typeof v === 'boolean' ? String(v) : v}`)
        .join('\n');
}

// CLI: read the three workflow_run fields from env, print GITHUB_OUTPUT lines.
if (process.argv[1] && process.argv[1].endsWith('alert-notification-matrix.mjs')) {
    process.stdout.write(`${toOutputLines(classifyAlert({
        workflowName: process.env.WF_NAME,
        conclusion: process.env.WF_CONCLUSION,
        event: process.env.WF_EVENT,
    }))}\n`);
}

export default { classifyAlert, COVERED_WORKFLOW_NAMES, FACTORY_WORKFLOW_NAMES, ALERT_CLASS, SEVERITY };
