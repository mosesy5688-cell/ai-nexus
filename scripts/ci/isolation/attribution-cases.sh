#!/usr/bin/env bash
#
# Free2AITools work order N -- ruling C, c4: the DISCRIMINATING attribution
# test. Without it, c2 (attribute from the records) and c3 (record the timeout
# source explicitly) are only declarations.
#
# WHAT IT DOES: makes the PROGRAM UNDER TEST deliberately exit 70, 71 and 124 --
# the same numbers the launcher's own gates use -- and asserts that attribution
# still names the program, not the gate. 70-76 were never a reserved range (c1);
# the codes are not remapped, because verbatim propagation is an intentional
# honesty property. Attribution has to hold up anyway, and it does so by reading
# the RECORDS: phaseD.launched and phaseD.rc both exist here, and the pre-gates
# left phaseC.rc=0 behind, so "the program exited 70" is distinguishable from
# "the precheck failed" without looking at the number at all.
#
# It also covers the timeout case, and this is where c3 does the work. A program
# that exits 124 immediately and a program the inner timeout killed return the
# SAME code and leave the SAME set of record files -- so the discrimination
# cannot come from which files are present. Each layer records its answer as a
# VALUE (`program` vs `inner` below, `propagated` vs `outer` above), and the two
# cases below differ only in those values.
#
# CI consumes attribution.txt and nothing else (c5), so every assertion below
# reads that one file.
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH="$HERE/netns-launch.sh"
POS="$HERE/pos-marker.mjs"
# shellcheck source=scripts/ci/isolation/exit-codes.sh
. "$HERE/exit-codes.sh"
# shellcheck source=scripts/ci/isolation/case-helpers.sh
. "$HERE/case-helpers.sh"

if [ "$(uname -s)" != Linux ]; then
  printf 'attribution-cases: requires a Linux runner (uname=%s); NOT RUN\n' "$(uname -s)" >&2
  exit 1
fi

WORK="${PWD}/.isolation-evidence/attribution-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$WORK"
FAILED=0

# run_program_exit <case> <code>: the program under test runs INSIDE the
# boundary, writes its marker, then exits with the requested code.
run_program_exit() {
  new_case "$1"
  RC=0
  "$LAUNCH" --evidence "$CASE_EVID" --phase-d-deadline 120 --total-deadline 600 \
    -- node "$POS" "$CASE_NONCE" "$2" \
    >"$CASE_EVID/driver.stdout" 2>"$CASE_EVID/driver.stderr" || RC=$?
  # Verbatim propagation is the honesty property: the launcher must hand back
  # the program's own code untouched, even when it collides with a gate code.
  expect_rc "$RC" "$2" "$1 verbatim propagation"
  # The program really ran: its OWN marker is present (N4-6), and the records
  # that drive attribution are all there.
  expect_present "$CASE_EVID/phaseD.marker"   "$1 program executed"
  expect_present "$CASE_EVID/phaseD.launched" "$1 phaseD.launched record"
  expect_present "$CASE_EVID/phaseD.rc"       "$1 phaseD.rc record"
  expect_present "$CASE_EVID/attribution.txt" "$1 attribution artifact"
  expect_attr "record.phaseD_launched" yes "$1"
  expect_attr exit_code_is_criterion no "$1"
  expect_attr basis records "$1"
}

# --------------------------------------------------- c4: program exits 70
# 70 is the launcher's PRECHECK code. Attribution must NOT say precheck.
note 'c4-70: the program exits 70; attribution must name the program, not the precheck'
run_program_exit c4-exit70 70
expect_attr verdict PROGRAM_FAILED 'c4-70'
expect_attr verdict_class TEST 'c4-70'
expect_attr "record.phaseD_rc" 70 'c4-70'
expect_attr "record.phaseC_rc" 0 'c4-70'
expect_attr timeout_source none 'c4-70'
if [ "$(attr_get verdict)" = ISOLATION_PRECHECK_FAILED ]; then
  bad 'c4-70: attribution mistook a program exit for a precheck failure'
fi

# --------------------------------------------------- c4: program exits 71
# 71 is the launcher's ESTABLISH code. Attribution must NOT say establish.
note 'c4-71: the program exits 71; attribution must not name the establish gate'
run_program_exit c4-exit71 71
expect_attr verdict PROGRAM_FAILED 'c4-71'
expect_attr verdict_class TEST 'c4-71'
expect_attr "record.phaseD_rc" 71 'c4-71'
if [ "$(attr_get verdict)" = ISOLATION_ESTABLISH_FAILED ]; then
  bad 'c4-71: attribution mistook a program exit for an establishment failure'
fi

# -------------------------------------------------- c4: program exits 124
# 124 is timeout(1)'s code. The program returns it IMMEDIATELY. c3 forbids
# inferring the source from a file's absence, so BOTH layers record a value
# here: phase D records `program` (it returned 124 itself, far inside its
# deadline) and the launcher records `propagated` (the subtree handed back a 124
# the outer deadline had nothing to do with). The files therefore EXIST and
# still do not make this a timeout -- the verdict comes from their values.
note 'c4-124: the program exits 124 instantly; attribution must not call it a timeout'
run_program_exit c4-exit124 124
expect_attr verdict PROGRAM_FAILED 'c4-124'
expect_attr verdict_class TEST 'c4-124'
expect_attr "record.phaseD_rc" 124 'c4-124'
expect_attr timeout_source program 'c4-124'
expect_present "$CASE_EVID/phaseD.timeout-source" 'c4-124 the source is RECORDED'
expect_grep 'phaseD.timeout-source=program' "$CASE_EVID/phaseD.timeout-source" 'c4-124 inner value'
expect_grep 'launcher.timeout-source=propagated' "$CASE_EVID/launcher.timeout-source" \
  'c4-124 outer value'
expect_attr "record.phaseD_timeout_source" program 'c4-124'
expect_attr "record.launcher_timeout_source" propagated 'c4-124'
if [ "$(attr_get verdict)" = PROGRAM_TIMEOUT ] || [ "$(attr_get verdict)" = LAUNCHER_TIMEOUT ]; then
  bad 'c4-124: attribution invented a timeout from the exit code alone'
fi
if [ "$(attr_get verdict)" = PROGRAM_INDETERMINATE ]; then
  bad 'c4-124: the source was not recorded, so attribution could not decide'
fi

# ------------------------------------- c3 positive: a REAL inner timeout
# The program sleeps past a deliberately tiny phase-D deadline, so timeout(1)
# really does kill it. Same exit code as the case above; different records.
note 'c3: a real inner timeout is recorded positively and attributed as one'
new_case c3-inner-timeout
RC=0
"$LAUNCH" --evidence "$CASE_EVID" --phase-d-deadline 3 --total-deadline 300 \
  -- sleep 90 >"$CASE_EVID/driver.stdout" 2>"$CASE_EVID/driver.stderr" || RC=$?
expect_rc "$RC" 124 'c3-inner'
expect_present "$CASE_EVID/phaseD.timeout-source" 'c3-inner source recorded'
expect_grep 'phaseD.timeout-source=inner' "$CASE_EVID/phaseD.timeout-source" 'c3-inner value'
expect_attr verdict PROGRAM_TIMEOUT 'c3-inner'
expect_attr timeout_source inner 'c3-inner'
# The discrimination that matters: SAME exit code as c4-124, and here the SAME
# two record FILES exist as well -- only their values differ. If the values were
# not the criterion these two cases would be indistinguishable.
if [ "$(attr_get verdict)" = PROGRAM_FAILED ]; then
  bad 'c3-inner: a real timeout was attributed as an ordinary program failure'
fi

# ------------------------------------- baseline: a clean pass still reads PASS
note 'c4-pass: a clean run still attributes as PASS'
run_program_exit c4-pass 0
expect_attr verdict PASS 'c4-pass'
expect_attr verdict_class PASS 'c4-pass'

printf '\nattribution cases failed expectations: %s\n' "$FAILED"
printf 'evidence root (kept): %s\n' "$WORK"
exit "$FAILED"
