// Free2AITools work order N-P5 item 0b (G-3) -- SOURCE-TEXT pins for case B in
// scripts/ci/isolation/counterexamples.sh, in the p9o-pins pattern: ONE pure
// function, handed the driver text and the committed fixture text, returning the
// list of pin failures ([] = every pin holds). It reads nothing, imports nothing
// and consults no environment. It says nothing about runtime behaviour; that
// exists only in the CI run that executes the driver.
//
// Every driver line matching ^\s*# is dropped before any comparison, so such a
// line can neither satisfy nor break a pin. Q1 is LINE-ALIGNED: the region must
// match whole remaining driver lines, once. The declaration census (no extra
// function heads, no alias/unalias/unset -f/function line) is P4 of p9o-pins.mjs,
// which covers the whole driver and lists case B's three functions.

const FIXTURE_LINES = 44;
const LOAD_BEARING = [
    // L2: the exact no-knob invocation through the production flags.
    // (A trailing backslash would escape String.raw's closing backtick, so these
    // two continuation lines are plain strings ending in an escaped backslash.)
    '  env -u F2AI_ISO_FAULT -u F2AI_ISO_FAULT_ACK "$1" --evidence "$CASE_EVID" --path-prefix "$CB" --stub-manifest "$MAN" \\',
    '    -- node "$POS" "$CASE_NONCE" >"$CASE_EVID/driver.stdout" 2>"$CASE_EVID/driver.stderr" || RC=$?; }',
    // L7: the rewrite is a sibling write then mv, only at the 2nd sentinel call.
    `    printf '%s\\n' '  if [ "$n" -eq 2 ]; then { cat "$D/curl"; echo "# case B: rewritten at sentinel call 2"; } >"$D/.curl.next"`,
    `    chmod 0755 "$D/.curl.next"; mv -f "$D/.curl.next" "$D/curl"; fi'; tail -n "+$((k + 1))" "$s"; } >"$CB/curl"`,
    // L2 read-back, L8 and L9 expectations.
    String.raw`  [ "$(grep '^FAULT' "$e/params.env")" = "$(printf 'FAULT=\nFAULT_ACK=')" ] || bad "$t: params.env FAULT/FAULT_ACK not both empty"`,
    '  grep -qxF "PATH_PREFIX=$CB" "$e/params.env" && grep -qxF "STUB_MANIFEST=$MAN" "$e/params.env" || bad "$t: params.env fixture paths"',
    `  expect_rc "$RC" "$F2AI_ISO_RC_STUB" "$t"; expect_grep 'PASS curl' "$e/stub-identity-post-drop.txt" "$t post-drop"`,
    `  [ "$(grep '^FAIL ' "$e/stub-identity-pre-phase-d.txt")" = 'FAIL curl identity mismatch' ] || bad "$t: pre-phase-d FAIL lines"`,
    '  [ "$(cat "$e/phaseC.rc" 2>/dev/null || echo ABSENT)" = 0 ] || bad "$t: phaseC.rc absent or not 0"',
    '  for f in marker launched rc; do expect_absent "$e/phaseD.$f" "$t"; done',
    '  expect_attr verdict ISOLATION_STUB_IDENTITY_FAILED "$t"; expect_attr verdict_class ISOLATION "$t"',
    `  [ "$(sha256sum "$CB/curl" | cut -d' ' -f1)" != "$(cut -f3 "$MAN")" ] || bad "$t: stub sha == manifest sha"`,
    '  [ "$(cat "$CB/count")" = 2 ] || bad "$t: fixture counter != 2 (stub dir not writable at the dropped identity?)"',
    '  [ -n "$n" ] && [ "$(grep -c -x -E -e "[0-9TZ:-]+ argv:--f2ai-iso-sentinel $n" "$e/stub-sentinel.log")" = 2 ] \\',
    // The original run: not redirected, FAILED not restored.
    `note 'case B: phase C green, then the pre-phase-d P-1 gate refuses a drifted stub'; caseb_run "$LAUNCH" caseb; caseb_expect caseB`,
    // M-B1..M-B5 (M-B5 in its alias and its PATH-shim form).
    `caseb_mutant M-B1 netns-phases.sh + "$G" '[ -n "$FAULT" ] || fail() { rec "M-B1 $1"; }'`,
    `caseb_mutant M-B2 netns-phases.sh + "$R" 'STUB_RC=0'`,
    `caseb_mutant M-B3 netns-phases.sh = "$G" ''`,
    `caseb_mutant M-B4 stub-identity.sh + '  : >"$report"' '  [ "$tag" != pre-phase-d ] || return 0'`,
    `caseb_mutant M-B5a netns-phases.sh + "$R" 'shopt -s expand_aliases; alias fail=rec'`,
    String.raw`caseb_mutant M-B5b netns-phases.sh + '# ------------------------- cache now exists' "PATH=\"$CBS:\$PATH\""`
];
const KILL = `  expect_grep 'phaseD.marker exists but must not' "$CASE_EVID/tripped.txt" "case B mutant $1 NOT killed"`;

export function casebPinFailures(driverText, fixtureText) {
    const out = [];
    const code = String(driverText).replace(/\r\n/g, '\n').split('\n').filter((l) => !/^\s*#/.test(l));
    const region = String(fixtureText).replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    // Q1: the fixture is ONE contiguous region of the driver's code lines, once.
    if (region.length !== FIXTURE_LINES) out.push(`Q1 fixture has ${region.length} lines, expected ${FIXTURE_LINES}`);
    const seen = `\n${code.join('\n')}\n`.split(`\n${region.join('\n')}\n`).length - 1;
    if (seen !== 1) out.push(`Q1 fixture region occurs ${seen} times in the driver code lines, expected 1`);
    // Q2: the load-bearing lines are inside that region, each exactly once.
    for (const l of LOAD_BEARING) {
        if (region.filter((r) => r === l).length !== 1) out.push(`Q2 not exactly once in region: ${l.trim()}`);
    }
    // Q3: the kill check sits AFTER the FAILED restore and is the last line of caseb_mutant.
    const kill = region.indexOf(KILL);
    const restore = region.findIndex((l) => l.includes('FAILED="$keep"'));
    if (kill < 0) out.push('Q3 kill check with the full phaseD.marker string is missing');
    if (restore < 0) out.push('Q3 FAILED="$keep" restore is missing');
    if (kill >= 0 && restore >= 0 && !(kill > restore)) out.push(`Q3 kill check (${kill}) is not after the restore (${restore})`);
    if (kill >= 0 && region[kill + 1] !== '}') out.push('Q3 kill check is not the last line of caseb_mutant');
    return out;
}
