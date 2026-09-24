#!/usr/bin/env bash
#
# Free2AITools work order N -- isolation launcher, OUTER entry point (phase B).
#
# WHAT IT DOES: probes the runner's ACTUAL unshare/setpriv capability (N5-3 --
# options are checked against this binary's own --help, never back-inferred from
# a newer man page), establishes a Linux network namespace, and hands the
# subtree to netns-establish.sh. Privilege is used for ESTABLISHMENT ONLY;
# netns-establish.sh drops it before phase C, and phase C + phase D then run at
# the SAME final UID/GID, groups, capabilities, environment and FD policy (N2-1).
#
# WHAT IT IS NOT (N-1 limitations L1-L5, stated, not hidden):
#   L1 it blocks network REACHABILITY, not syscalls in general; not a sandbox.
#   L2 lo still exists inside, so it proves "cannot reach outside", NOT
#      "no network API activity happened".
#   L3 DNS failure is recorded separately from tool error and is AUXILIARY.
#   L4 establishment needs CAP_SYS_ADMIN (or a user namespace). Whether THIS
#      runner grants it is UNVERIFIED -- ruling B1: proven by a normal PR run
#      after a push is approved, never by a dispatch fired to obtain proof.
#   L5 it does not stop filesystem exfiltration. Host IPC channels are NOT
#      filed under L5 (N3-3): every CLASSIFIED channel in
#      classified-channels.tsv is MASKED while still privileged, and a masking
#      that fails aborts at the establish stage with 71 before phase C runs.
#      The masking is the defence; phase C only confirms read-only that it took.
#      No audit ever connects to a live classified socket.
#
# FAIL-CLOSED: every pre-phase-D failure exits non-zero and phase D is not
# started. There is no unisolated fallback anywhere in this chain (B1).
#
# usage: netns-launch.sh [--evidence DIR] [--path-prefix DIR]
#                        [--stub-manifest FILE] [--total-deadline SEC]
#                        [--phase-d-deadline SEC] -- CMD [ARGS...]
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci/isolation/exit-codes.sh
. "$HERE/exit-codes.sh"
# shellcheck source=scripts/ci/isolation/finalize.sh
. "$HERE/finalize.sh"

EVID=""; PATH_PREFIX=""; STUB_MANIFEST=""; TOTAL_DEADLINE=1800; PHASE_D_DEADLINE=1500
while [ $# -gt 0 ]; do
  case "$1" in
    --evidence)         EVID="${2-}";             shift 2 ;;
    --path-prefix)      PATH_PREFIX="${2-}";      shift 2 ;;
    --stub-manifest)    STUB_MANIFEST="${2-}";    shift 2 ;;
    --total-deadline)   TOTAL_DEADLINE="${2-}";   shift 2 ;;
    --phase-d-deadline) PHASE_D_DEADLINE="${2-}"; shift 2 ;;
    --) shift; break ;;
    *) printf 'netns-launch: unknown option: %s\n' "$1" >&2; exit "$F2AI_ISO_RC_USAGE" ;;
  esac
done
if [ $# -lt 1 ]; then
  printf 'netns-launch: no program under test after --\n' >&2
  exit "$F2AI_ISO_RC_USAGE"
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NONCE="$(od -An -tx1 -N8 /dev/urandom | tr -d ' \n')"
[ -n "$EVID" ] || EVID="${PWD}/.isolation-evidence/${STAMP}-${NONCE}"
mkdir -p "$EVID"
LOG="$EVID/launcher.log"
rec() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG"; }
# c5: f2ai_finalize emits the single attribution artifact. It is called from
# fail() as well as from the normal tail, so the file CI reads exists for EVERY
# terminal outcome -- see finalize.sh for why that matters.
fail() { rec "FAIL($2) $1"; printf 'netns-launch: %s\n' "$1" >&2; f2ai_finalize "$2"; exit "$2"; }

rec "BEGIN stamp=$STAMP nonce=$NONCE pwd=$PWD"
rec "ARGV_PHASE_D $*"
printf '%s\n' "$@" >"$EVID/phaseD.argv"

# Phase A (checkout, setup-node, npm ci) already ran OUTSIDE this launcher under
# the existing CI dependency preparation that ruling B2 covers. Nothing here
# downloads or installs anything, and phase D may NOT network to fill a missing
# dependency -- inside the boundary it cannot: it has no route.

# ---------------------------------------------------------------- outer record
{
  printf 'uid=%s gid=%s groups=%s\n' "$(id -u)" "$(id -g)" "$(id -G)"
  printf 'host_netns=%s\n'  "$(readlink /proc/self/ns/net  2>/dev/null || echo UNREADABLE)"
  printf 'host_userns=%s\n' "$(readlink /proc/self/ns/user 2>/dev/null || echo UNREADABLE)"
  printf 'host_pidns=%s\n'  "$(readlink /proc/self/ns/pid  2>/dev/null || echo UNREADABLE)"
  printf 'uname=%s\n' "$(uname -a 2>/dev/null || echo UNKNOWN)"
} >"$EVID/outer-identity.txt"
HOST_NETNS="$(readlink /proc/self/ns/net 2>/dev/null || echo UNREADABLE)"
HOST_USERNS="$(readlink /proc/self/ns/user 2>/dev/null || echo UNREADABLE)"
[ "$HOST_NETNS" != UNREADABLE ] || fail "cannot read /proc/self/ns/net" "$F2AI_ISO_RC_PRECHECK"

# ------------------------------------------------- N5-3 actual-version probing
for t in unshare setpriv nsenter ip timeout node; do
  p="$(command -v "$t" 2>/dev/null || true)"
  printf '%s\t%s\n' "$t" "${p:-MISSING}" | tee -a "$EVID/tool-resolution.txt"
  [ -n "$p" ] || fail "required tool missing: $t" "$F2AI_ISO_RC_PRECHECK"
done
unshare --version 2>&1 | tee "$EVID/unshare-version.txt" || true
setpriv --version 2>&1 | tee "$EVID/setpriv-version.txt" || true
unshare --help    2>&1 | tee "$EVID/unshare-help.txt"    || true
setpriv --help    >"$EVID/setpriv-help.txt"    2>&1 || true

have_opt() { grep -F -q -- "$2" "$1"; }
UNSHARE_REQUIRED="--net --fork --pid --mount-proc --kill-child"
for o in $UNSHARE_REQUIRED; do
  if have_opt "$EVID/unshare-help.txt" "$o"; then
    printf 'unshare %s PRESENT\n' "$o" >>"$EVID/option-probe.txt"
  else
    printf 'unshare %s ABSENT\n' "$o" >>"$EVID/option-probe.txt"
    fail "this runner's unshare does not advertise $o" "$F2AI_ISO_RC_PRECHECK"
  fi
done
SETPRIV_REQUIRED="--reuid --regid --clear-groups --no-new-privs --inh-caps --bounding-set"
for o in $SETPRIV_REQUIRED; do
  if have_opt "$EVID/setpriv-help.txt" "$o"; then
    printf 'setpriv %s PRESENT\n' "$o" >>"$EVID/option-probe.txt"
  else
    printf 'setpriv %s ABSENT\n' "$o" >>"$EVID/option-probe.txt"
    fail "this runner's setpriv does not advertise $o" "$F2AI_ISO_RC_PRECHECK"
  fi
done
SETPRIV_AMBIENT=no
if have_opt "$EVID/setpriv-help.txt" "--ambient-caps"; then SETPRIV_AMBIENT=yes; fi
printf 'setpriv --ambient-caps %s\n' "$SETPRIV_AMBIENT" >>"$EVID/option-probe.txt"

# --------------------------------------------- establishment mode selection.
# There is no "fall back to running it unisolated" branch here or anywhere else.
MODE=""
if [ "${F2AI_ISO_FAULT:-}" = establish ] && [ "${F2AI_ISO_FAULT_ACK:-}" = 1 ]; then
  # F1 counterexample: forced establishment failure. This knob can ONLY make the
  # launcher stop earlier; it can never relax the boundary or start phase D.
  rec "FAULT=establish (F1 counterexample)"
  fail "forced establishment failure (F1 counterexample)" "$F2AI_ISO_RC_ESTABLISH"
fi
SUDO_RC=0
sudo -n unshare --net -- true >"$EVID/probe-sudo-unshare.txt" 2>&1 || SUDO_RC=$?
printf 'probe sudo-unshare rc=%s\n' "$SUDO_RC" >>"$EVID/option-probe.txt"
if [ "$SUDO_RC" -eq 0 ]; then
  MODE=sudo
else
  USERNS_RC=0
  unshare --user --map-root-user --net -- true >"$EVID/probe-userns.txt" 2>&1 || USERNS_RC=$?
  printf 'probe userns-unshare rc=%s capsh=%s\n' "$USERNS_RC" \
    "$(command -v capsh 2>/dev/null || echo MISSING)" >>"$EVID/option-probe.txt"
  if [ "$USERNS_RC" -eq 0 ] && command -v capsh >/dev/null 2>&1; then
    MODE=userns
  else
    fail "no usable establishment mode (sudo rc=$SUDO_RC, userns rc=$USERNS_RC)" \
      "$F2AI_ISO_RC_ESTABLISH"
  fi
fi
rec "MODE=$MODE"

# The env handed to phases C/D is built from `env -i` plus an explicit
# allowlist, so PATH is rebuilt from scratch. The directories that actually hold
# the phase-A-provisioned toolchain (setup-node puts node/npm in the hosted tool
# cache, NOT in /usr/bin) are resolved HERE and recorded, so the allowlist stays
# explicit without making phase D unable to find node.
TOOL_PATH=""
for t in node npm npx; do
  d="$(command -v "$t" 2>/dev/null || true)"
  if [ -n "$d" ]; then
    d="$(cd "$(dirname "$d")" && pwd)"
    case ":$TOOL_PATH:" in *":$d:"*) : ;; *) TOOL_PATH="${TOOL_PATH:+$TOOL_PATH:}$d" ;; esac
  fi
done
printf 'TOOL_PATH=%s\n' "$TOOL_PATH" >>"$EVID/tool-resolution.txt"

PARAMS="$EVID/params.env"
{
  printf 'TOOL_PATH=%s\n'        "$TOOL_PATH"
  printf 'MODE=%s\n'             "$MODE"
  printf 'EVID=%s\n'             "$EVID"
  printf 'HERE=%s\n'             "$HERE"
  printf 'HOST_NETNS=%s\n'       "$HOST_NETNS"
  printf 'HOST_USERNS=%s\n'      "$HOST_USERNS"
  printf 'TARGET_UID=%s\n'       "$(id -u)"
  printf 'TARGET_GID=%s\n'       "$(id -g)"
  printf 'TARGET_HOME=%s\n'      "${HOME:-/tmp}"
  printf 'TARGET_CWD=%s\n'       "$PWD"
  printf 'PATH_PREFIX=%s\n'      "$PATH_PREFIX"
  printf 'STUB_MANIFEST=%s\n'    "$STUB_MANIFEST"
  printf 'PHASE_D_DEADLINE=%s\n' "$PHASE_D_DEADLINE"
  printf 'SETPRIV_AMBIENT=%s\n'  "$SETPRIV_AMBIENT"
  printf 'FAULT=%s\n'            "${F2AI_ISO_FAULT:-}"
  printf 'FAULT_ACK=%s\n'        "${F2AI_ISO_FAULT_ACK:-}"
  printf 'NONCE=%s\n'            "$NONCE"
} >"$PARAMS"

UNSHARE_ARGS=(--net --fork --pid --mount-proc --kill-child)
[ "$MODE" = userns ] && UNSHARE_ARGS=(--user --map-root-user "${UNSHARE_ARGS[@]}")

# N5-3: overall deadline plus interrupt cleanup. Descendants are NOT left
# unmanaged: --fork --pid --mount-proc makes the establish stage PID 1 of a new
# PID namespace (the kernel SIGKILLs every descendant when PID 1 exits) and
# --kill-child SIGKILLs that child if unshare itself dies.
CHILD=0
# c3: on signal arrival the outer timeout source is written FIRST, before any
# cleanup, so it exists even if the teardown is itself interrupted. Attribution
# never infers a timeout from a file's absence.
on_signal() {
  printf 'launcher.timeout-source=outer\nreason=signal\nutc=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$EVID/launcher.timeout-source"
  if [ "$CHILD" -ne 0 ]; then kill -TERM "$CHILD" 2>/dev/null || true; fi
}
trap on_signal INT TERM
L_START="$(date -u +%s)"
if [ "$MODE" = sudo ]; then
  timeout -k 30s "${TOTAL_DEADLINE}s" \
    sudo -n unshare "${UNSHARE_ARGS[@]}" -- \
    bash "$HERE/netns-establish.sh" "$PARAMS" -- "$@" &
else
  timeout -k 30s "${TOTAL_DEADLINE}s" \
    unshare "${UNSHARE_ARGS[@]}" -- \
    bash "$HERE/netns-establish.sh" "$PARAMS" -- "$@" &
fi
CHILD=$!
CHILD_RC=0
wait "$CHILD" || CHILD_RC=$?
trap - INT TERM
L_END="$(date -u +%s)"
L_ELAPSED=$((L_END - L_START))

rec "CHILD_RC=$CHILD_RC elapsed=${L_ELAPSED}s total_deadline=${TOTAL_DEADLINE}s"
printf 'elapsed_s=%s\ndeadline_s=%s\n' "$L_ELAPSED" "$TOTAL_DEADLINE" >"$EVID/launcher.timing"
# c3, second positive path: the outer timeout(1) kills the child without
# signalling THIS shell, so the trap above cannot see it. A 124 is therefore
# recorded from the MEASUREMENT, and both answers are written as values -- the
# non-timeout answer is a record too, never the lack of one. `propagated` means
# the subtree handed back 124 of its own accord well inside the outer deadline,
# and attribution treats only `outer` as a launcher timeout.
if [ "$CHILD_RC" -eq 124 ] && [ ! -f "$EVID/launcher.timeout-source" ]; then
  if [ "$L_ELAPSED" -ge "$TOTAL_DEADLINE" ]; then L_TS=outer; L_WHY=deadline
  else L_TS=propagated; L_WHY=subtree-returned-124-inside-the-outer-deadline; fi
  printf 'launcher.timeout-source=%s\nreason=%s\nelapsed_s=%s\ndeadline_s=%s\n' \
    "$L_TS" "$L_WHY" "$L_ELAPSED" "$TOTAL_DEADLINE" >"$EVID/launcher.timeout-source"
fi

# c5: the single machine-readable artifact, emitted here on the normal tail and
# by fail() on every gate path, so it exists for every terminal outcome.
f2ai_finalize "$CHILD_RC"

# Exit code is propagated VERBATIM and is NOT remapped. No pipeline at the tail,
# no `|| true` on a gate, no unconditional `exit 0`: evidence collection cannot
# turn a failure into a success, and attribution is not allowed to either.
exit "$CHILD_RC"
