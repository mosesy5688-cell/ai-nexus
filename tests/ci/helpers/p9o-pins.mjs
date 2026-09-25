// Free2AITools work order N-P5 item 0 (M10) -- SOURCE-TEXT pins for case P9o in
// scripts/ci/isolation/counterexamples.sh. ONE pure function: it is handed the
// driver text and the committed fixture text and returns the list of pin
// failures ([] = every pin holds). It reads nothing, imports nothing and
// consults no environment, so the vitest pin and any off-tree mutant proof call
// the identical code on whatever text they were given. It says nothing about
// runtime behaviour; that exists only in the CI run that executes the driver.
//
// Comment-only lines are dropped from the driver before any comparison, so a
// comment can neither satisfy nor break a pin; an edit to a code line inside
// the region (a trailing comment included) breaks P1.

const FIXTURE_LINES = 31;
const LOAD_BEARING = [
    // P2: the knob record, the exact failure set (both ends of the one-liner),
    // all three phase-D absences, and the attribution pair.
    String.raw`  [ "$(grep '^FAULT' "$e/params.env")" = "$(printf 'FAULT=\nFAULT_ACK=')" ] || bad "$t: params.env FAULT/FAULT_ACK not both empty"`,
    `  [ "$(node -e 'let o="NO_REPORT"; try { const r = require(process.argv[1]); o = r.failures.map((f) => f.id)`,
    `    process.stdout.write(o)' "$e/selftest-report.json")" = 'P9-no-stray-fds|1' ] || bad "$t: failures != [P9] or stray != [1]"`,
    '  for f in marker launched rc; do expect_absent "$e/phaseD.$f" "$t"; done',
    '  expect_attr verdict ISOLATION_SELFTEST_FAILED "$t"; expect_attr verdict_class ISOLATION "$t"'
];
const KILL = `  expect_grep 'phaseD.marker exists but must not' "$CASE_EVID/tripped.txt" "P9o mutant $1 NOT killed"`;
const DECLARED = ['p9o_run', 'p9o_expect', 'p9o_mutant'];

export function p9oPinFailures(driverText, fixtureText) {
    const out = [];
    const code = String(driverText).replace(/\r\n/g, '\n').split('\n').filter((l) => !/^\s*#/.test(l));
    const region = String(fixtureText).replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    // P1: the fixture is ONE contiguous region of the driver's code lines, once.
    if (region.length !== FIXTURE_LINES) out.push(`P1 fixture has ${region.length} lines, expected ${FIXTURE_LINES}`);
    const seen = code.join('\n').split(region.join('\n')).length - 1;
    if (seen !== 1) out.push(`P1 fixture region occurs ${seen} times in the driver code lines, expected 1`);
    // P2: the load-bearing lines are inside that region.
    for (const l of LOAD_BEARING) if (!(region.indexOf(l) > 0)) out.push(`P2 missing from region: ${l.trim()}`);
    // P3: the kill check keeps the full marker string, sits AFTER the FAILED
    // restore, and is the last statement of p9o_mutant.
    const kill = region.indexOf(KILL);
    const restore = region.findIndex((l) => l.includes('FAILED="$keep"'));
    if (kill < 0) out.push('P3 kill check with the full phaseD.marker string is missing');
    if (restore < 0) out.push('P3 FAILED="$keep" restore is missing');
    if (kill >= 0 && restore >= 0 && !(kill > restore)) out.push(`P3 kill check (${kill}) is not after the restore (${restore})`);
    if (kill >= 0 && region[kill + 1] !== '}') out.push('P3 kill check is not the last line of p9o_mutant');
    // P4: the driver declares exactly the three P9o functions and nothing that
    // could redefine or alias one.
    const heads = code.map((l) => /^\s*(\w+)\s*\(\s*\)\s*\{/.exec(l)?.[1]).filter(Boolean);
    if (heads.join() !== DECLARED.join()) out.push(`P4 declared functions are [${heads}], expected [${DECLARED}]`);
    for (const l of code) {
        if (/^\s*(function\s|alias\s|unalias\s|unset\s+-f)/.test(l)) out.push(`P4 forbidden declaration: ${l.trim()}`);
    }
    return out;
}
