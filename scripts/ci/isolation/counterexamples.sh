#!/usr/bin/env bash
#
# Free2AITools work order N -- executable counterexamples F1-F4 plus the non-vacuous positive
# control. N5-1: every case below invokes the REAL launcher with real shell semantics. Nothing is
# re-verified in a second wrapper standing in for it.
#
# N5-2: a pre-phase-D failure must exit non-zero AND phase D must not have started; phase D's own
# failure must exit non-zero; evidence collection must not convert either into success. This driver
# therefore has no pipe-tail exit masking, no unconditional `exit 0`, and its own exit status is the
# number of failed expectations. Evidence is written to disk and NEVER deleted on failure.
#
# N4-6: "phase D did not start" is asserted from the marker the program under test writes ITSELF,
# plus the launcher's gate-specific exit code -- never from the absence of a log line.
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH="$HERE/netns-launch.sh"; POS="$HERE/pos-marker.mjs"
# shellcheck source=scripts/ci/isolation/exit-codes.sh
. "$HERE/exit-codes.sh"
# shellcheck source=scripts/ci/isolation/case-helpers.sh
. "$HERE/case-helpers.sh"
if [ "$(uname -s)" != Linux ]; then
  printf 'counterexamples: this requires a Linux runner (uname=%s); NOT RUN\n' "$(uname -s)" >&2; exit 1
fi
WORK="${PWD}/.isolation-evidence/counterexamples-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$WORK"; FAILED=0

# ---------------------------------------------------------------- POSITIVE
note 'POS: the real launcher runs the designated program inside the boundary'; new_case pos; RC=0
"$LAUNCH" --evidence "$CASE_EVID" --phase-d-deadline 120 --total-deadline 600 \
  -- node "$POS" "$CASE_NONCE" >"$CASE_EVID/driver.stdout" 2>"$CASE_EVID/driver.stderr" || RC=$?
expect_rc "$RC" 0 'POS'; expect_present "$CASE_EVID/phaseD.marker" 'POS'
expect_grep "$CASE_NONCE" "$CASE_EVID/phaseD.marker" 'POS marker nonce'
expect_grep 'F2AI_ISO_PHASE_D_EXECUTED' "$CASE_EVID/phaseD.marker" 'POS marker id'
expect_grep '"capEff": "0000000000000000"' "$CASE_EVID/phaseD.marker" 'POS caps empty'
expect_grep '"noNewPrivs": "1"' "$CASE_EVID/phaseD.marker" 'POS no_new_privs'
expect_present "$CASE_EVID/selftest-report.json" 'POS self-test report'
expect_grep 'BOUNDARY_PROVEN_AT_FINAL_IDENTITY' "$CASE_EVID/selftest.stdout.txt" 'POS verdict'
expect_present "$CASE_EVID/attribution.txt" 'POS attribution artifact'
expect_present "$CASE_EVID/launch.nonce" 'POS d4 unforgeable marker'; expect_attr verdict PASS 'POS'
expect_attr verdict_class PASS 'POS'; expect_attr timeout_source none 'POS'; expect_attr exit_code_is_criterion no 'POS'
# The marker is written by the program itself, so this compares the namespace the PROGRAM observed
# against the namespace the launcher started from.
POS_NS="$(sed -n 's/.*"netns": *"\([^"]*\)".*/\1/p' "$CASE_EVID/phaseD.marker" || true)"
HOST_NS="$(sed -n 's/^host_netns=//p' "$CASE_EVID/outer-identity.txt" || true)"
if [ -z "$POS_NS" ] || [ "$POS_NS" = "$HOST_NS" ]; then
  bad "POS: program netns '$POS_NS' is not a new namespace (host '$HOST_NS')"; fi

# ---------------------------------------------------------------------- F1
note 'F1: establishment failure exits non-zero and does not start phase D'; new_case f1; RC=0
F2AI_ISO_FAULT=establish F2AI_ISO_FAULT_ACK=1 "$LAUNCH" --evidence "$CASE_EVID" \
  -- node "$POS" "$CASE_NONCE" >"$CASE_EVID/driver.stdout" 2>"$CASE_EVID/driver.stderr" || RC=$?
expect_rc "$RC" "$F2AI_ISO_RC_ESTABLISH" 'F1'
# c5: the artifact CI reads must exist even for the EARLIEST gate. This is the case that would be
# missing it if it were only emitted on the normal tail.
expect_present "$CASE_EVID/attribution.txt" 'F1 c5 artifact on the earliest gate'; expect_attr verdict_class ISOLATION 'F1'
expect_absent "$CASE_EVID/phaseD.marker" 'F1'; expect_absent "$CASE_EVID/phaseD.rc" 'F1'
expect_absent "$CASE_EVID/phaseD.launched" 'F1'

# ---------------------------------------------------------------------- F2
note 'F2: self-test failure exits non-zero and does not start phase D'; new_case f2; RC=0
F2AI_ISO_FAULT=selftest F2AI_ISO_FAULT_ACK=1 "$LAUNCH" --evidence "$CASE_EVID" \
  -- node "$POS" "$CASE_NONCE" >"$CASE_EVID/driver.stdout" 2>"$CASE_EVID/driver.stderr" || RC=$?
expect_rc "$RC" "$F2AI_ISO_RC_SELFTEST" 'F2'
# The record has to name the SELF-TEST gate, not the establish stage. That is only true because the
# fault writes phaseC.rc=1 on its way out (c2).
expect_grep '1' "$CASE_EVID/phaseC.rc" 'F2 phase C verdict recorded'; expect_attr verdict ISOLATION_SELFTEST_FAILED 'F2'
expect_attr "record.phaseC_rc" 1 'F2'; expect_absent "$CASE_EVID/phaseD.marker" 'F2'
expect_absent "$CASE_EVID/phaseD.rc" 'F2'; expect_absent "$CASE_EVID/phaseD.launched" 'F2'

# ---------------------------------------------------------------------- F3
# N3-2 controlled inherited FD. The bait is a LOCAL REGULAR FILE; it connects to no external network.
# Anti-vacuity: present BEFORE cleanup, absent after, and absent from the program's own FD table at
# the final identity.
note 'F3: a deliberately inherited descriptor is closed before phase D'; new_case f3; RC=0
F2AI_ISO_FAULT=fd F2AI_ISO_FAULT_ACK=1 "$LAUNCH" --evidence "$CASE_EVID" \
  -- node "$POS" "$CASE_NONCE" >"$CASE_EVID/driver.stdout" 2>"$CASE_EVID/driver.stderr" || RC=$?
expect_rc "$RC" 0 'F3'; expect_grep 'fd-bait.txt' "$CASE_EVID/fd-before.txt" 'F3 anti-vacuity (bait was inherited)'
expect_no_grep 'fd-bait.txt' "$CASE_EVID/fd-after.txt" 'F3 cleanup'; expect_present "$CASE_EVID/phaseD.marker" 'F3'
expect_no_grep 'fd-bait.txt' "$CASE_EVID/phaseD.marker" 'F3 final-identity FD table'

# --------------------------------------------------------------------- F3b
note 'F3b: an uncleaned inherited descriptor fails the self-test'; new_case f3b; RC=0
F2AI_ISO_FAULT=fd-keep F2AI_ISO_FAULT_ACK=1 "$LAUNCH" --evidence "$CASE_EVID" \
  -- node "$POS" "$CASE_NONCE" >"$CASE_EVID/driver.stdout" 2>"$CASE_EVID/driver.stderr" || RC=$?
if [ "$RC" -eq 0 ]; then bad 'F3b: an uncleaned descriptor was NOT detected'; fi
expect_absent "$CASE_EVID/phaseD.marker" 'F3b'; expect_grep 'P9-no-stray-fds' "$CASE_EVID/selftest.stdout.txt" 'F3b detection id'

# ---------------------------------------------------------------------- F4
# P-1 after the environment and privilege switch (N5-5).
note 'F4: the stub is still the resolved command after the privilege switch'; new_case f4
STUBBIN="$WORK/f4-stubbin"; mkdir -p "$STUBBIN"; cp "$HERE/stub-curl.sh" "$STUBBIN/curl"; chmod 0755 "$STUBBIN/curl"
printf 'curl\t%s\t%s\t%s\n' "$STUBBIN/curl" \
  "$(sha256sum "$STUBBIN/curl" | cut -d' ' -f1)" "$(stat -c %s "$STUBBIN/curl")" >"$WORK/f4-manifest.tsv"; RC=0
"$LAUNCH" --evidence "$CASE_EVID" --path-prefix "$STUBBIN" --stub-manifest "$WORK/f4-manifest.tsv" \
  -- node "$POS" "$CASE_NONCE" >"$CASE_EVID/driver.stdout" 2>"$CASE_EVID/driver.stderr" || RC=$?
expect_rc "$RC" 0 'F4'; expect_grep 'PASS curl' "$CASE_EVID/stub-identity-post-drop.txt" 'F4 post-drop'
expect_grep 'PASS curl' "$CASE_EVID/stub-identity-pre-phase-d.txt" 'F4 pre-phase-d'
expect_present "$CASE_EVID/stub-sentinel.log" 'F4 sentinel record'; expect_present "$CASE_EVID/phaseD.marker" 'F4'

# --------------------------------------------------------------------- F4b
# P-3's non-vacuous negative: put the same gate around a REAL system binary. A real binary leaves no
# sentinel argv record, so the gate must refuse and phase D must not start.
note 'F4b: the same gate around a real system binary must refuse'; new_case f4b
REALCAT="$(command -v cat || true)"
if [ -z "$REALCAT" ]; then bad 'F4b: no system cat to point the gate at -- the negative control cannot run'
else
  printf 'cat\t%s\t%s\t%s\n' "$REALCAT" \
    "$(sha256sum "$REALCAT" | cut -d' ' -f1)" "$(stat -c %s "$REALCAT")" >"$WORK/f4b-manifest.tsv"; RC=0
  "$LAUNCH" --evidence "$CASE_EVID" --stub-manifest "$WORK/f4b-manifest.tsv" \
    -- node "$POS" "$CASE_NONCE" >"$CASE_EVID/driver.stdout" 2>"$CASE_EVID/driver.stderr" || RC=$?
  expect_rc "$RC" "$F2AI_ISO_RC_STUB" 'F4b'; expect_absent "$CASE_EVID/phaseD.marker" 'F4b'
  expect_grep 'FAIL cat' "$CASE_EVID/stub-identity-post-drop.txt" 'F4b refusal recorded'
fi

# ---------------------------------------------------------------------- b4
# Ruling B, b4: deliberately make ONE classified channel masking FAIL. Under option jia the masking
# IS the defence, so this must abort at the ESTABLISH stage with 71 and the audit must never start --
# asserted by the ABSENCE of selftest.stdout.txt, which phases.sh creates the moment it runs phase C.
note 'b4: a classified masking failure aborts at establish; the audit never starts'; new_case b4; RC=0
F2AI_ISO_FAULT=mask F2AI_ISO_FAULT_ACK=1 "$LAUNCH" --evidence "$CASE_EVID" \
  -- node "$POS" "$CASE_NONCE" >"$CASE_EVID/driver.stdout" 2>"$CASE_EVID/driver.stderr" || RC=$?
expect_rc "$RC" "$F2AI_ISO_RC_ESTABLISH" 'b4'
expect_grep 'FORCED_FAILURE' "$CASE_EVID/ipc-mask.txt" 'b4 the masking really failed'
expect_absent "$CASE_EVID/selftest.stdout.txt" 'b4 the audit never started'
expect_absent "$CASE_EVID/selftest-report.json" 'b4 no self-test report'
expect_absent "$CASE_EVID/phaseC.rc" 'b4 phase C never ran'; expect_absent "$CASE_EVID/phaseD.marker" 'b4 phase D never ran'
expect_attr verdict ISOLATION_ESTABLISH_FAILED 'b4'; expect_attr verdict_class ISOLATION 'b4'

# --------------------------------------------------------------------- b4r
# b4, the REAL variant. The case above marks a masking failed without calling mount(8), so by itself
# it leaves "would a GENUINE masking failure be caught?" untested -- the same vacuity trap ruling D
# names. This one makes mount(8) really refuse (tmpfs over a regular file) and asserts the identical
# outcome through the ordinary code path: rc from mount, MASK_FAILED in the report, abort at
# establish with 71, audit never started.
note 'b4r: a REAL mount(8) failure on a classified channel also aborts at establish'; new_case b4r; RC=0
F2AI_ISO_FAULT=mask-real F2AI_ISO_FAULT_ACK=1 "$LAUNCH" --evidence "$CASE_EVID" \
  -- node "$POS" "$CASE_NONCE" >"$CASE_EVID/driver.stdout" 2>"$CASE_EVID/driver.stderr" || RC=$?
expect_rc "$RC" "$F2AI_ISO_RC_ESTABLISH" 'b4r'
expect_grep 'MASK_FAILED' "$CASE_EVID/ipc-mask.txt" 'b4r a real mount(8) failure was recorded'
expect_no_grep 'REAL_FAULT_DID_NOT_FAIL' "$CASE_EVID/ipc-mask.txt" 'b4r the fault was not vacuous'
expect_absent "$CASE_EVID/selftest.stdout.txt" 'b4r the audit never started'
expect_absent "$CASE_EVID/phaseC.rc" 'b4r phase C never ran'
expect_absent "$CASE_EVID/phaseD.marker" 'b4r phase D never ran'; expect_attr verdict ISOLATION_ESTABLISH_FAILED 'b4r'

# --------------------------------------------------------------------- P9o
# N-P5 item 0 (M10): an ORDINARY run, no FAULT knob (cleared, read back from
# params.env), stdout a genuinely inherited /dev/zero. Establish passes it (only
# a socket on 0/1/2 is refused there); P9 refuses it. P9 alone is red: must stop.
p9o_run() { new_case "$2"; RC=0; env -u F2AI_ISO_FAULT -u F2AI_ISO_FAULT_ACK "$1" --evidence \
  "$CASE_EVID" -- node "$POS" "$CASE_NONCE" >/dev/zero 2>"$CASE_EVID/driver.stderr" || RC=$?; }
p9o_expect() {
  local e="$CASE_EVID" t="$1" z; z="$(printf '1\t/dev/zero')"
  [ "$(grep '^FAULT' "$e/params.env")" = "$(printf 'FAULT=\nFAULT_ACK=')" ] || bad "$t: params.env FAULT/FAULT_ACK not both empty"
  expect_rc "$RC" "$F2AI_ISO_RC_SELFTEST" "$t"; expect_absent "$e/fd-violations.txt" "$t establish violation"
  expect_grep "$z" "$e/fd-after.txt" "$t establish passed fd 1"; expect_grep "$z" "$e/fd-final.txt" "$t fd 1 in P9 ledger"
  [ "$(node -e 'let o="NO_REPORT"; try { const r = require(process.argv[1]); o = r.failures.map((f) => f.id)
    + "|" + r.n4_0.checks.find((c) => c.id === "P9-no-stray-fds").observed.stray.map((s) => s.fd); } catch {}
    process.stdout.write(o)' "$e/selftest-report.json")" = 'P9-no-stray-fds|1' ] || bad "$t: failures != [P9] or stray != [1]"
  case "$(cat "$e/phaseC.rc" 2>/dev/null || echo ABSENT)" in ABSENT|0|'') bad "$t: phaseC.rc absent or 0" ;; esac
  for f in marker launched rc; do expect_absent "$e/phaseD.$f" "$t"; done
  expect_attr verdict ISOLATION_SELFTEST_FAILED "$t"; expect_attr verdict_class ISOLATION "$t"
}
note 'P9o: an ordinary run whose stdout P9 refuses stops at the phase-C gate'; p9o_run "$LAUNCH" p9o; p9o_expect P9o
# Discrimination IN THIS RUN, on COPIES (originals never written): each mutant must
# START phase D. A copy broken any other way starts no phase D, so cannot pass.
SHIM="$WORK/p9o-shim"; mkdir -p "$SHIM"; printf '#!/bin/sh\n"%s" "$@"\nexit 0\n' "$(command -v node)" >"$SHIM/node"
chmod 0755 "$SHIM/node"
p9o_mutant() {
  local m="$WORK/p9o-mut-$1" keep="$FAILED"; cp -a "$HERE" "$m"
  awk -v a="$2" -v l="$3" '{ print } index($0, a) == 1 { print l; n++ } END { exit (n != 1) }' \
    "$HERE/netns-phases.sh" >"$m/netns-phases.sh" || { bad "P9o mutant $1: anchor not unique"; return; }
  p9o_run "$m/netns-launch.sh" "p9o-$1"; p9o_expect "$1" 2>"$CASE_EVID/tripped.txt"; FAILED="$keep"
  sed "s/^/  [$1 tripped] /" "$CASE_EVID/tripped.txt"
  expect_grep 'phaseD.marker exists but must not' "$CASE_EVID/tripped.txt" "P9o mutant $1 NOT killed"
}
p9o_mutant M10 'if [ "$C_RC" -ne 0 ]; then' '  [ -n "$FAULT" ] || fail() { rec "M10 $1"; }'
p9o_mutant F2a-exit 'fail() {' 'exit() { return 0; }'
p9o_mutant F2b-node 'fail() {' 'node() { case "$1" in *netns-selftest.mjs) return 0 ;; esac; command node "$@"; }'
p9o_mutant G2a-alias 'fail() {' 'shopt -s expand_aliases; alias fail=rec'
p9o_mutant G2b-path 'fail() {' "PATH=\"$SHIM:\$PATH\""
p9o_mutant MUT-16 'rec "phase C rc=$C_RC"' 'C_RC=0'

# ------------------------------------------- ruling C c4: attribution cases.
# A separate file so neither driver exceeds the CES line limit. Its failure count is ADDED to this
# one's, never swallowed.
note 'handing over to the attribution discriminating cases (c4)'
ATTR_CASES_RC=0; bash "$HERE/attribution-cases.sh" || ATTR_CASES_RC=$?
FAILED=$((FAILED + ATTR_CASES_RC))

printf '\nfailed expectations: %s\n' "$FAILED"; printf 'evidence root (kept): %s\n' "$WORK"
exit "$FAILED"
