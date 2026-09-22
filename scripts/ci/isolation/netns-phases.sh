#!/usr/bin/env bash
#
# Free2AITools work order N -- phases C and D at the FINAL identity.
#
# Everything below this point runs with the same UID/GID, groups, capabilities,
# environment and FD policy (N2-1). Nothing here is privileged: the boundary was
# established by netns-establish.sh, which dropped privilege before exec'ing
# this file. Phase C proves the boundary FROM INSIDE at that identity; phase D
# runs the program under test at that identity or does not run at all.
#
# Ruling B1 / N5-2: a pre-phase-D failure exits non-zero and phase D is NOT
# started. There is no unisolated fallback and no `continue-on-error` anywhere.
set -Eeuo pipefail

PARAMS="${1:?params file required}"; shift
[ "${1-}" = "--" ] && shift
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci/isolation/exit-codes.sh
. "$HERE/exit-codes.sh"
# shellcheck source=scripts/ci/isolation/stub-identity.sh
. "$HERE/stub-identity.sh"

EVID=; STUB_MANIFEST=; PHASE_D_DEADLINE=; NONCE=; FAULT=; FAULT_ACK=; TARGET_CWD=
while IFS='=' read -r k v; do
  case "$k" in
    EVID|STUB_MANIFEST|PHASE_D_DEADLINE|NONCE|FAULT|FAULT_ACK|TARGET_CWD)
      printf -v "$k" '%s' "$v" ;;
  esac
done <"$PARAMS"

SHELL_PID=$$
LOG="$EVID/phases.log"
rec() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG"; }
fail() { rec "FAIL($2) $1"; printf 'netns-phases: %s\n' "$1" >&2; exit "$2"; }
export F2AI_ISO_SENTINEL_LOG="$EVID/stub-sentinel.log"

# ------------------------------------------------------- final identity record
{
  printf 'uid_line=%s\n'  "$(grep -E '^Uid:'  /proc/self/status | tr '\t' ' ')"
  printf 'gid_line=%s\n'  "$(grep -E '^Gid:'  /proc/self/status | tr '\t' ' ')"
  printf 'groups=%s\n'    "$(grep -E '^Groups:' /proc/self/status | tr '\t' ' ')"
  grep -E '^Cap(Inh|Prm|Eff|Bnd|Amb):|^NoNewPrivs:|^Seccomp:' /proc/self/status
  printf 'netns=%s\n'  "$(readlink /proc/self/ns/net  2>/dev/null || echo UNREADABLE)"
  printf 'userns=%s\n' "$(readlink /proc/self/ns/user 2>/dev/null || echo UNREADABLE)"
  printf 'pidns=%s\n'  "$(readlink /proc/self/ns/pid  2>/dev/null || echo UNREADABLE)"
  printf 'pid=%s cwd=%s\n' "$SHELL_PID" "$PWD"
} >"$EVID/final-identity.txt"
for p in "/proc/$SHELL_PID/fd/"*; do
  [ -e "$p" ] || continue
  printf '%s\t%s\n' "${p##*/}" "$(readlink "$p" 2>/dev/null || echo UNREADABLE)" \
    >>"$EVID/fd-final.txt"
done
env | LC_ALL=C sort >"$EVID/final-env.txt"
rec "FINAL IDENTITY recorded"

# ----------------------------------------- P-1, first re-check after the switch
STUB_RC=0
f2ai_stub_verify "$STUB_MANIFEST" "$EVID" "post-drop" "$NONCE" || STUB_RC=$?
rec "stub identity (post-drop) rc=$STUB_RC"
[ "$STUB_RC" -eq 0 ] || fail "P-1 stub identity failed after the privilege switch" \
  "$F2AI_ISO_RC_STUB"

# ------------------------------------------------------------- phase C self-test
if [ "$FAULT" = selftest ] && [ "$FAULT_ACK" = 1 ]; then
  # F2 counterexample: forced self-test failure. Like the F1 knob it can only
  # stop the run earlier; it can never relax the boundary or start phase D.
  rec "FAULT=selftest (F2 counterexample)"
  # c2: the ledger has to say WHICH gate stopped the run. This fault stands in
  # for a phase C verdict of FAILURE, so phaseC.rc records exactly that. Without
  # the record there is no phase C evidence to read and attribution would fall
  # through to the establish stage -- naming the wrong gate.
  printf '1\n' >"$EVID/phaseC.rc"
  fail "forced self-test failure (F2 counterexample)" "$F2AI_ISO_RC_SELFTEST"
fi
C_RC=0
node "$HERE/netns-selftest.mjs" "$PARAMS" >"$EVID/selftest.stdout.txt" \
  2>"$EVID/selftest.stderr.txt" || C_RC=$?
printf '%s\n' "$C_RC" >"$EVID/phaseC.rc"
rec "phase C rc=$C_RC"
if [ "$C_RC" -ne 0 ]; then
  # Phase D is not started. The absence of the program's own marker file, not a
  # missing log line, is what the counterexamples assert (N4-6).
  fail "phase C self-test failed (see selftest.stdout.txt) -- phase D NOT started" \
    "$F2AI_ISO_RC_SELFTEST"
fi

# ------------------------- P-1, second re-check: phase C ran node and a resolver
# ------------------------- cache now exists, so resolution is proven again here.
STUB_RC=0
f2ai_stub_verify "$STUB_MANIFEST" "$EVID" "pre-phase-d" "$NONCE" || STUB_RC=$?
rec "stub identity (pre-phase-d) rc=$STUB_RC"
[ "$STUB_RC" -eq 0 ] || fail "P-1 stub identity failed before phase D" \
  "$F2AI_ISO_RC_STUB"

# ------------------------------------------------------------------- phase D
# Launcher-side ledger ONLY (for ruling B3 classification). It is NOT the
# evidence that D executed: that is the marker the program itself writes.
{
  printf 'utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'launcher_pid=%s\n' "$SHELL_PID"
  printf 'argv=%s\n' "$*"
} >"$EVID/phaseD.launched"
D_RC=0
D_START="$(date -u +%s)"
timeout -k 15s "${PHASE_D_DEADLINE}s" "$@" || D_RC=$?
D_END="$(date -u +%s)"
D_ELAPSED=$((D_END - D_START))
printf '%s\n' "$D_RC" >"$EVID/phaseD.rc"
printf 'elapsed_s=%s\ndeadline_s=%s\n' "$D_ELAPSED" "$PHASE_D_DEADLINE" >"$EVID/phaseD.timing"
# c3: the timeout SOURCE is recorded POSITIVELY whenever phase D returns 124 --
# it is never inferred from a file's absence. timeout(1) returns 124 both when
# it killed the child and when the child itself exited 124, so the code alone
# cannot say which; the measured elapsed time against the deadline can, and the
# VERDICT of that measurement is what is written. "inner" and "program" are two
# different RECORDED values -- not a record and the lack of one. Writing it
# unconditionally is the point: if this file were ever missing while phaseD.rc
# said 124, attribution reports that as INDETERMINATE rather than guessing.
if [ "$D_RC" -eq 124 ]; then
  if [ "$D_ELAPSED" -ge "$PHASE_D_DEADLINE" ]; then D_TS=inner; else D_TS=program; fi
  printf 'phaseD.timeout-source=%s\nelapsed_s=%s\ndeadline_s=%s\n' \
    "$D_TS" "$D_ELAPSED" "$PHASE_D_DEADLINE" >"$EVID/phaseD.timeout-source"
fi
rec "phase D rc=$D_RC elapsed=${D_ELAPSED}s deadline=${PHASE_D_DEADLINE}s"
# Verbatim propagation: no pipeline at the tail, no `|| true`, no `exit 0`.
# The code is NOT remapped for attribution -- attribution reads the records.
exit "$D_RC"
