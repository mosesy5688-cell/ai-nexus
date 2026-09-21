#!/usr/bin/env bash
#
# Free2AITools work order N -- executable counterexamples F1-F4 plus the
# non-vacuous positive control. N5-1: every case below invokes the REAL
# launcher with real shell semantics. Nothing is re-verified in a second
# wrapper standing in for it.
#
# N5-2: a pre-phase-D failure must exit non-zero AND phase D must not have
# started; phase D's own failure must exit non-zero; evidence collection must
# not convert either into success. This driver therefore has no pipe-tail exit
# masking, no unconditional `exit 0`, and its own exit status is the number of
# failed expectations. Evidence is written to disk and NEVER deleted on failure.
#
# N4-6: "phase D did not start" is asserted from the marker the program under
# test writes ITSELF, plus the launcher's gate-specific exit code -- never from
# the absence of a log line.
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH="$HERE/netns-launch.sh"
POS="$HERE/pos-marker.mjs"
# shellcheck source=scripts/ci/isolation/exit-codes.sh
. "$HERE/exit-codes.sh"

if [ "$(uname -s)" != Linux ]; then
  printf 'counterexamples: this requires a Linux runner (uname=%s); NOT RUN\n' "$(uname -s)" >&2
  exit 1
fi

WORK="${PWD}/.isolation-evidence/counterexamples-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$WORK"
FAILED=0

note() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
bad()  { FAILED=$((FAILED + 1)); printf 'EXPECTATION FAILED: %s\n' "$*" >&2; }

expect_rc() { if [ "$1" -ne "$2" ]; then bad "$3: expected rc $2, observed $1"; fi; }
expect_absent()  { if [ -e "$1" ]; then bad "$2: $1 exists but must not"; fi; }
expect_present() { if [ ! -e "$1" ]; then bad "$2: $1 is missing"; fi; }
expect_grep() {
  if [ ! -f "$2" ]; then bad "$3: $2 missing"; return; fi
  if ! grep -F -q -- "$1" "$2"; then bad "$3: '$1' not found in $2"; fi
}
expect_no_grep() {
  if [ -f "$2" ] && grep -F -q -- "$1" "$2"; then bad "$3: '$1' unexpectedly present in $2"; fi
}
new_case() { CASE_EVID="$WORK/$1"; mkdir -p "$CASE_EVID"; CASE_NONCE="n-$1-$RANDOM$RANDOM"; }

# ---------------------------------------------------------------- POSITIVE
note 'POS: the real launcher runs the designated program inside the boundary'
new_case pos
RC=0
"$LAUNCH" --evidence "$CASE_EVID" --phase-d-deadline 120 --total-deadline 600 \
  -- node "$POS" "$CASE_NONCE" >"$CASE_EVID/driver.stdout" 2>"$CASE_EVID/driver.stderr" || RC=$?
expect_rc "$RC" 0 'POS'
expect_present "$CASE_EVID/phaseD.marker" 'POS'
expect_grep "$CASE_NONCE" "$CASE_EVID/phaseD.marker" 'POS marker nonce'
expect_grep 'F2AI_ISO_PHASE_D_EXECUTED' "$CASE_EVID/phaseD.marker" 'POS marker id'
expect_grep '"capEff": "0000000000000000"' "$CASE_EVID/phaseD.marker" 'POS caps empty'
expect_grep '"noNewPrivs": "1"' "$CASE_EVID/phaseD.marker" 'POS no_new_privs'
expect_present "$CASE_EVID/selftest-report.json" 'POS self-test report'
expect_grep 'BOUNDARY_PROVEN_AT_FINAL_IDENTITY' "$CASE_EVID/selftest.stdout.txt" 'POS verdict'
# The marker is written by the program itself, so this compares the namespace
# the PROGRAM observed against the namespace the launcher started from.
POS_NS="$(sed -n 's/.*"netns": *"\([^"]*\)".*/\1/p' "$CASE_EVID/phaseD.marker" || true)"
HOST_NS="$(sed -n 's/^host_netns=//p' "$CASE_EVID/outer-identity.txt" || true)"
if [ -z "$POS_NS" ] || [ "$POS_NS" = "$HOST_NS" ]; then
  bad "POS: program netns '$POS_NS' is not a new namespace (host '$HOST_NS')"
fi

# ---------------------------------------------------------------------- F1
note 'F1: establishment failure exits non-zero and does not start phase D'
new_case f1
RC=0
F2AI_ISO_FAULT=establish F2AI_ISO_FAULT_ACK=1 "$LAUNCH" --evidence "$CASE_EVID" \
  -- node "$POS" "$CASE_NONCE" >"$CASE_EVID/driver.stdout" 2>"$CASE_EVID/driver.stderr" || RC=$?
expect_rc "$RC" "$F2AI_ISO_RC_ESTABLISH" 'F1'
expect_absent "$CASE_EVID/phaseD.marker"   'F1'
expect_absent "$CASE_EVID/phaseD.rc"       'F1'
expect_absent "$CASE_EVID/phaseD.launched" 'F1'

# ---------------------------------------------------------------------- F2
note 'F2: self-test failure exits non-zero and does not start phase D'
new_case f2
RC=0
F2AI_ISO_FAULT=selftest F2AI_ISO_FAULT_ACK=1 "$LAUNCH" --evidence "$CASE_EVID" \
  -- node "$POS" "$CASE_NONCE" >"$CASE_EVID/driver.stdout" 2>"$CASE_EVID/driver.stderr" || RC=$?
expect_rc "$RC" "$F2AI_ISO_RC_SELFTEST" 'F2'
expect_absent "$CASE_EVID/phaseD.marker"   'F2'
expect_absent "$CASE_EVID/phaseD.rc"       'F2'
expect_absent "$CASE_EVID/phaseD.launched" 'F2'

# ---------------------------------------------------------------------- F3
# N3-2 controlled inherited FD. The bait is a LOCAL REGULAR FILE; it connects to
# no external network. Anti-vacuity: present BEFORE cleanup, absent after, and
# absent from the program's own FD table at the final identity.
note 'F3: a deliberately inherited descriptor is closed before phase D'
new_case f3
RC=0
F2AI_ISO_FAULT=fd F2AI_ISO_FAULT_ACK=1 "$LAUNCH" --evidence "$CASE_EVID" \
  -- node "$POS" "$CASE_NONCE" >"$CASE_EVID/driver.stdout" 2>"$CASE_EVID/driver.stderr" || RC=$?
expect_rc "$RC" 0 'F3'
expect_grep    'fd-bait.txt' "$CASE_EVID/fd-before.txt"  'F3 anti-vacuity (bait was inherited)'
expect_no_grep 'fd-bait.txt' "$CASE_EVID/fd-after.txt"   'F3 cleanup'
expect_present "$CASE_EVID/phaseD.marker" 'F3'
expect_no_grep 'fd-bait.txt' "$CASE_EVID/phaseD.marker"  'F3 final-identity FD table'

# --------------------------------------------------------------------- F3b
note 'F3b: an uncleaned inherited descriptor fails the self-test'
new_case f3b
RC=0
F2AI_ISO_FAULT=fd-keep F2AI_ISO_FAULT_ACK=1 "$LAUNCH" --evidence "$CASE_EVID" \
  -- node "$POS" "$CASE_NONCE" >"$CASE_EVID/driver.stdout" 2>"$CASE_EVID/driver.stderr" || RC=$?
if [ "$RC" -eq 0 ]; then bad 'F3b: an uncleaned descriptor was NOT detected'; fi
expect_absent "$CASE_EVID/phaseD.marker" 'F3b'
expect_grep 'P9-no-stray-fds' "$CASE_EVID/selftest.stdout.txt" 'F3b detection id'

# ---------------------------------------------------------------------- F4
# P-1 after the environment and privilege switch (N5-5).
note 'F4: the stub is still the resolved command after the privilege switch'
new_case f4
STUBBIN="$WORK/f4-stubbin"; mkdir -p "$STUBBIN"
cp "$HERE/stub-curl.sh" "$STUBBIN/curl"
chmod 0755 "$STUBBIN/curl"
printf 'curl\t%s\t%s\t%s\n' "$STUBBIN/curl" \
  "$(sha256sum "$STUBBIN/curl" | cut -d' ' -f1)" "$(stat -c %s "$STUBBIN/curl")" \
  >"$WORK/f4-manifest.tsv"
RC=0
"$LAUNCH" --evidence "$CASE_EVID" --path-prefix "$STUBBIN" \
  --stub-manifest "$WORK/f4-manifest.tsv" -- node "$POS" "$CASE_NONCE" \
  >"$CASE_EVID/driver.stdout" 2>"$CASE_EVID/driver.stderr" || RC=$?
expect_rc "$RC" 0 'F4'
expect_grep 'PASS curl' "$CASE_EVID/stub-identity-post-drop.txt"   'F4 post-drop'
expect_grep 'PASS curl' "$CASE_EVID/stub-identity-pre-phase-d.txt" 'F4 pre-phase-d'
expect_present "$CASE_EVID/stub-sentinel.log" 'F4 sentinel record'
expect_present "$CASE_EVID/phaseD.marker"     'F4'

# --------------------------------------------------------------------- F4b
# P-3's non-vacuous negative: put the same gate around a REAL system binary.
# A real binary leaves no sentinel argv record, so the gate must refuse and
# phase D must not start.
note 'F4b: the same gate around a real system binary must refuse'
new_case f4b
REALCAT="$(command -v cat || true)"
if [ -z "$REALCAT" ]; then
  bad 'F4b: no system cat to point the gate at -- the negative control cannot run'
else
  printf 'cat\t%s\t%s\t%s\n' "$REALCAT" \
    "$(sha256sum "$REALCAT" | cut -d' ' -f1)" "$(stat -c %s "$REALCAT")" \
    >"$WORK/f4b-manifest.tsv"
  RC=0
  "$LAUNCH" --evidence "$CASE_EVID" --stub-manifest "$WORK/f4b-manifest.tsv" \
    -- node "$POS" "$CASE_NONCE" \
    >"$CASE_EVID/driver.stdout" 2>"$CASE_EVID/driver.stderr" || RC=$?
  expect_rc "$RC" "$F2AI_ISO_RC_STUB" 'F4b'
  expect_absent "$CASE_EVID/phaseD.marker" 'F4b'
  expect_grep 'FAIL cat' "$CASE_EVID/stub-identity-post-drop.txt" 'F4b refusal recorded'
fi

printf '\nfailed expectations: %s\n' "$FAILED"
printf 'evidence root (kept): %s\n' "$WORK"
exit "$FAILED"
