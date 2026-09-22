// Free2AITools work order N -- attribution from the RECORDS (ruling C, c2/c5).
//
// c1 settled that exit codes are NOT remapped: verbatim propagation is an
// intentional honesty property, and 70-76 are not a reserved range -- the
// program under test may legitimately exit 70, 71 or 124, and in the c4 test it
// deliberately does. So the exit code cannot be the criterion.
//
// c2: the criterion is the set of RECORDS each stage writes as it passes --
// phaseC.rc, phaseD.launched, phaseD.rc, launcher.rc -- plus the explicitly
// recorded timeout source (c3). Presence of a record means a stage was reached;
// absence means it was not. The exit code is carried as a hint and labelled as
// one.
//
// c3, and this is the part that is easy to get subtly wrong: the timeout
// decision is made from the VALUE of a recorded source, never from whether the
// record is there. Both stages write a source whenever their layer returned
// 124 -- `inner`/`program` below, `outer`/`propagated` above -- so "the program
// returned 124 itself" is a positive record rather than the absence of one, and
// only `outer` is a launcher timeout. A 124 with NO source recorded is not
// silently judged either way: it is reported as indeterminate.
//
// c5: the result is ONE machine-readable file, attribution.txt. CI reads its
// verdict from that file and from nothing else.
//
// Generating attribution must never change an outcome. This program writes a
// file and exits 0 even when it cannot decide; the launcher ignores its status
// and still exits with the child's verbatim code.
import fs from 'node:fs';

const EVID = process.argv[2];
if (!EVID) {
    process.stderr.write('attribute: an evidence directory is required\n');
    process.exit(0);
}

const exists = (n) => { try { return fs.existsSync(`${EVID}/${n}`); } catch { return false; } };
const text = (n) => { try { return fs.readFileSync(`${EVID}/${n}`, 'utf8'); } catch { return ''; } };
const num = (n) => { const t = text(n).trim(); return /^-?\d+$/.test(t) ? Number(t) : null; };
const kv = (n, k) =>
    (text(n).match(new RegExp(`^${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=(.*)$`, 'm'))
        || [])[1] ?? null;

/**
 * A recorded timeout source, by VALUE. `null` means no record at all, which is
 * a distinct state from any value and is never treated as "no timeout".
 * `legacy` is the value assumed for a record written before the values existed.
 */
const source = (file, legacy) => {
    if (!exists(file)) return null;
    const v = (kv(file, file) || '').trim();
    return v || legacy;
};

/** Every input, read once, so the artifact can show exactly what decided it. */
const R = {
    launcherRc: num('launcher.rc'),
    launcherTimeoutSource: source('launcher.timeout-source', 'outer'),
    launcherTimeoutReason: kv('launcher.timeout-source', 'reason'),
    phaseCRc: exists('phaseC.rc') ? num('phaseC.rc') : null,
    phaseDLaunched: exists('phaseD.launched'),
    phaseDRc: exists('phaseD.rc') ? num('phaseD.rc') : null,
    phaseDTimeoutSource: source('phaseD.timeout-source', 'inner'),
    phaseDElapsed: kv('phaseD.timing', 'elapsed_s'),
    phaseDDeadline: kv('phaseD.timing', 'deadline_s'),
    launcherElapsed: kv('launcher.timing', 'elapsed_s'),
    launcherDeadline: kv('launcher.timing', 'deadline_s')
};

/** Stage evidence used only to say WHICH pre-phase-C gate stopped the run. */
function establishDetail() {
    const mask = text('ipc-mask.txt');
    if (/^(MASK_FAILED|FORCED_FAILURE|LIST_MISSING)/m.test(mask)) {
        return ['ISOLATION_ESTABLISH_FAILED',
            'a classified host IPC channel could not be masked; see ipc-mask.txt'];
    }
    if (exists('fd-violations.txt')) {
        return ['ISOLATION_FD_CLEANUP_FAILED', 'see fd-violations.txt'];
    }
    if (/^FAIL /m.test(text('stub-identity-post-drop.txt'))
        || /^FAIL /m.test(text('stub-identity-pre-phase-d.txt'))) {
        return ['ISOLATION_STUB_IDENTITY_FAILED',
            'P-1 resolution or identity check failed after the privilege switch'];
    }
    if (!exists('ns-identity.txt')) {
        return ['ISOLATION_PRECHECK_FAILED',
            'the establish stage was never entered: tooling, option probe or mode selection'];
    }
    return ['ISOLATION_ESTABLISH_FAILED',
        'the establish stage started but did not reach the self-test'];
}

/**
 * The decision table. Order matters and every branch is record-driven.
 * Nothing below reads an exit code to choose a branch.
 */
function decide() {
    // Only the recorded VALUE `outer` is a launcher timeout. `propagated` means
    // the subtree handed back 124 well inside the outer deadline, so the outer
    // layer did not end anything and the question moves down to phase D.
    if (R.launcherTimeoutSource === 'outer') {
        return ['LAUNCHER_TIMEOUT', 'ISOLATION',
            `the outer deadline or a signal ended the run (reason=`
            + `${R.launcherTimeoutReason ?? 'unrecorded'})`];
    }
    if (R.phaseDLaunched) {
        if (R.phaseDRc === null) {
            return ['PROGRAM_INDETERMINATE', 'INDETERMINATE',
                'phase D started but recorded no exit code'];
        }
        if (R.phaseDTimeoutSource === 'inner') {
            return ['PROGRAM_TIMEOUT', 'TEST',
                `phase D hit its own deadline (${R.phaseDElapsed}s of ${R.phaseDDeadline}s)`];
        }
        if (R.phaseDRc === 124 && R.phaseDTimeoutSource === null) {
            // c3: never guess. The producer writes a source for every 124, so
            // having none here means the evidence set is incomplete -- which is
            // reported as such rather than resolved in either direction.
            return ['PROGRAM_INDETERMINATE', 'INDETERMINATE',
                'phase D returned 124 but no timeout source was recorded, so whether '
                + 'the inner deadline fired cannot be decided from this evidence'];
        }
        if (R.phaseDRc === 0) {
            return ['PASS', 'PASS', 'the boundary held and the program under test succeeded'];
        }
        return ['PROGRAM_FAILED', 'TEST',
            `the program under test ran inside the boundary and exited ${R.phaseDRc}; `
            + 'this is its own code and says nothing about the isolation gates'];
    }
    if (R.phaseCRc !== null) {
        if (R.phaseCRc === 0) {
            return ['ISOLATION_INDETERMINATE', 'INDETERMINATE',
                'the self-test passed but phase D was never launched'];
        }
        return ['ISOLATION_SELFTEST_FAILED', 'ISOLATION',
            'phase C did not prove the boundary; phase D was not started'];
    }
    const [verdict, detail] = establishDetail();
    return [verdict, 'ISOLATION', detail];
}

const [verdict, verdictClass, detail] = decide();
// The reported source is the recorded value, in layer order: an outer timeout
// wins, then phase D's own recorded answer (`inner` or `program`), then the
// named anomaly of a 124 with nothing recorded, then whatever the outer layer
// recorded that was not a timeout (`propagated`), and only then `none`.
const timeoutSource = R.launcherTimeoutSource === 'outer' ? 'outer'
    : (R.phaseDTimeoutSource
        ?? (R.phaseDRc === 124 ? 'unrecorded' : (R.launcherTimeoutSource ?? 'none')));
const out = [
    'attribution_version=1',
    `utc=${new Date().toISOString()}`,
    `verdict=${verdict}`,
    `verdict_class=${verdictClass}`,
    'basis=records',
    'exit_code_is_criterion=no',
    `exit_code_hint=${R.launcherRc === null ? 'unrecorded' : R.launcherRc}`,
    `record.launcher_rc=${R.launcherRc === null ? 'absent' : R.launcherRc}`,
    `record.phaseC_rc=${R.phaseCRc === null ? 'absent' : R.phaseCRc}`,
    `record.phaseD_launched=${R.phaseDLaunched ? 'yes' : 'no'}`,
    `record.phaseD_rc=${R.phaseDRc === null ? 'absent' : R.phaseDRc}`,
    // The raw source records are carried verbatim next to the resolved answer,
    // so a reader can see that the verdict came from a value and not from a
    // missing file.
    `record.launcher_timeout_source=${R.launcherTimeoutSource ?? 'absent'}`,
    `record.phaseD_timeout_source=${R.phaseDTimeoutSource ?? 'absent'}`,
    `timeout_source=${timeoutSource}`,
    `timing.phaseD_elapsed_s=${R.phaseDElapsed ?? 'absent'}`,
    `timing.phaseD_deadline_s=${R.phaseDDeadline ?? 'absent'}`,
    `timing.launcher_elapsed_s=${R.launcherElapsed ?? 'absent'}`,
    `timing.launcher_deadline_s=${R.launcherDeadline ?? 'absent'}`,
    `detail=${detail}`,
    ''
].join('\n');

try {
    fs.writeFileSync(`${EVID}/attribution.txt`, out);
} catch (e) {
    process.stderr.write(`attribute: could not write attribution.txt: ${e?.message}\n`);
}
process.stdout.write(out);
process.exit(0);
