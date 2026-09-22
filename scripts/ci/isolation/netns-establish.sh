#!/usr/bin/env bash
#
# Free2AITools work order N -- PRIVILEGED establishment stage (inside the new
# net/pid/mount namespaces, still capable). It is PID 1 of the new PID namespace.
#
# N2-1: privilege is used HERE and ONLY here. This stage brings lo up, creates
# the CONTROLLED test namespace used by the escape check, attempts the N3-3 IPC
# mitigations, cleans file descriptors, then drops privilege and execs the
# phase C/D stage. It never runs the program under test itself.
#
# N2-2: the drop sets no_new_privs AND empties the capability bounding set AND
# switches UID/GID. no_new_privs is NOT claimed to remove existing capabilities
# (the kernel documentation says it does not cover all privilege changes); it is
# one of three measures, and the actual capability sets are MEASURED in phase C
# from /proc/self/status. If the drop did not take, phase C fails closed.
set -Eeuo pipefail

PARAMS="${1:?params file required}"; shift
[ "${1-}" = "--" ] && shift
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci/isolation/exit-codes.sh
. "$HERE/exit-codes.sh"
# shellcheck source=scripts/ci/isolation/mask-channels.sh
. "$HERE/mask-channels.sh"

MODE=; EVID=; HOST_NETNS=; HOST_USERNS=; TARGET_UID=; TARGET_GID=; TARGET_HOME=
TARGET_CWD=; PATH_PREFIX=; STUB_MANIFEST=; PHASE_D_DEADLINE=; SETPRIV_AMBIENT=
FAULT=; FAULT_ACK=; NONCE=; TOOL_PATH=
while IFS='=' read -r k v; do
  case "$k" in
    MODE|EVID|HOST_NETNS|HOST_USERNS|TARGET_UID|TARGET_GID|TARGET_HOME|TARGET_CWD|\
PATH_PREFIX|STUB_MANIFEST|PHASE_D_DEADLINE|SETPRIV_AMBIENT|FAULT|FAULT_ACK|NONCE|TOOL_PATH)
      printf -v "$k" '%s' "$v" ;;
  esac
done <"$PARAMS"

SHELL_PID=$$
LOG="$EVID/establish.log"
# WO-N diagnostic: the record is ALSO teed to stdout, so it reaches the job log
# and does not depend on the evidence tree surviving as an artifact.
rec() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }
# WO-N diagnostic: exit 71 covers four different conditions, so STAGE names the
# establishment stage in progress and fail() prints ONE named line on the way
# out. Record only: no gate, no condition and no exit code changes.
STAGE=unshare
fail() {
  rec "FAIL($2) $1"
  if [ "$2" = "$F2AI_ISO_RC_ESTABLISH" ]; then
    printf 'ISOLATION_ESTABLISH_STAGE_FAILED=%s detail=%s\n' "$STAGE" "$1"
  fi
  printf 'netns-establish: %s\n' "$1" >&2
  exit "$2"
}
rec "BEGIN pid=$SHELL_PID mode=$MODE euid=$(id -u)"

# ------------------------------------------------ N2-3 namespace identity
SUB_NETNS="$(readlink /proc/self/ns/net  2>/dev/null || echo UNREADABLE)"
SUB_USERNS="$(readlink /proc/self/ns/user 2>/dev/null || echo UNREADABLE)"
SUB_PIDNS="$(readlink /proc/self/ns/pid  2>/dev/null || echo UNREADABLE)"
{
  printf 'host_netns=%s\nsub_netns=%s\n'   "$HOST_NETNS"  "$SUB_NETNS"
  printf 'host_userns=%s\nsub_userns=%s\n' "$HOST_USERNS" "$SUB_USERNS"
  printf 'sub_pidns=%s\n' "$SUB_PIDNS"
  printf 'establish_uid=%s establish_caps=%s\n' "$(id -u)" \
    "$(grep -E '^Cap(Eff|Prm|Bnd):' /proc/self/status | tr '\n' ' ')"
} >"$EVID/ns-identity.txt"
[ "$SUB_NETNS" != UNREADABLE ] || fail "cannot read sub netns id" "$F2AI_ISO_RC_ESTABLISH"
[ "$SUB_NETNS" != "$HOST_NETNS" ] || \
  fail "netns id unchanged ($SUB_NETNS) -- no new network namespace" "$F2AI_ISO_RC_ESTABLISH"

# lo is brought up deliberately (limitation L2): the boundary proves "cannot
# reach outside", never "no network API activity". Test runners need loopback.
STAGE=lo
LO_RC=0; ip link set lo up >>"$LOG" 2>&1 || LO_RC=$?
rec "ip link set lo up rc=$LO_RC"
[ "$LO_RC" -eq 0 ] || fail "could not bring lo up inside the namespace" "$F2AI_ISO_RC_ESTABLISH"
ip -o link show   >"$EVID/inside-links.txt"  2>&1 || true
ip route show     >"$EVID/inside-route4.txt" 2>&1 || true
ip -6 route show  >"$EVID/inside-route6.txt" 2>&1 || true

# --------------------------------- N2-3 CONTROLLED test namespace for the
# escape check. It is NOT the host namespace and nothing is ever transmitted
# into it: the check is "can this final identity join a namespace it should not
# be able to join", answered with `true` as the payload.
STAGE=controlled-ns
CTRL_TTL=$(( PHASE_D_DEADLINE + 300 ))
unshare --net -- setpriv --reuid="$TARGET_UID" --regid="$TARGET_GID" --clear-groups \
  -- sleep "$CTRL_TTL" &
CTRL_PID=$!
# WO-N: the readiness predicate is DIVERGENCE, not readability. Between the fork
# and the child's own unshare(2), /proc/$CTRL_PID/ns/net is ALREADY readable and
# still holds the PARENT (subtree) id, so "readable" measures the wrong thing.
# For this pid the id changes exactly once -- when its unshare(2) succeeds --
# so a reading that DIFFERS from the subtree id cannot be the pre-exec value,
# and the anti-vacuity join below re-dereferences that same path anyway.
# Bounded wait: 15 x 0.2s = 3.0s.
CTRL_NS=""; CTRL_SEEN=0; CTRL_PROBE=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  CTRL_PROBE="$(readlink "/proc/$CTRL_PID/ns/net" 2>/dev/null || true)"
  if [ -n "$CTRL_PROBE" ]; then
    CTRL_SEEN=1; CTRL_NS="$CTRL_PROBE"
    if [ "$CTRL_NS" != "$SUB_NETNS" ]; then break; fi
  fi
  sleep 0.2
done
rec "control-ns readiness seen=$CTRL_SEEN ns=${CTRL_NS:-NONE} sub=$SUB_NETNS"
# Two timeouts that mean DIFFERENT things and stay distinguishable: never
# readable at all (no live child was ever observed) versus readable the whole
# time but never diverging (the child's unshare(2) did not take).
[ "$CTRL_SEEN" -eq 1 ] || \
  fail "controlled test namespace did not come up" "$F2AI_ISO_RC_ESTABLISH"
[ "$CTRL_NS" != "$SUB_NETNS" ] || \
  fail "controlled ns never diverged from subtree" "$F2AI_ISO_RC_ESTABLISH"
# Anti-vacuity: WHILE STILL PRIVILEGED, joining it must SUCCEED. Without this,
# a post-drop failure could just mean a broken handle rather than a refusal.
CTRL_PRE_RC=0
nsenter --net="/proc/$CTRL_PID/ns/net" -- true >>"$LOG" 2>&1 || CTRL_PRE_RC=$?
rec "control-ns pre-drop join rc=$CTRL_PRE_RC ns=$CTRL_NS pid=$CTRL_PID"
[ "$CTRL_PRE_RC" -eq 0 ] || \
  fail "controlled-ns join failed while privileged -- escape check would be vacuous" \
    "$F2AI_ISO_RC_ESTABLISH"

# ----------------------------------- N3-3 host IPC channels, the strict option
# THE MASKING ITSELF IS LOAD-BEARING. This is not best effort and the phase C
# check is not what carries it: any CLASSIFIED channel that exists and cannot be
# masked aborts HERE with exit 71, and phase C never runs. The point is that
# "the subtree never touched a live container-runtime or credential socket" is a
# CONSTRUCTIVE fact established before anything ran -- not something an audit
# explains after the fact. Nothing in this step probes or connects to a live
# socket; the only operations are stat and mount.
# Phase C's remaining job for these channels is a READ-ONLY confirmation that
# the mask took (the path is no longer a socket) -- corroboration, not the
# defence. Non-classified channels are inventoried there and never probed.
# Nothing here is filed under limitation L5: L5 is about filesystem
# exfiltration, and these channels are removed rather than excused.
# The channel list is read from classified-channels.tsv; no path or pattern is
# hardcoded in this file.
STAGE=classified-masking
MASK_RC=0
f2ai_mask_classified "$HERE/classified-channels.tsv" "$EVID" "$FAULT" "$FAULT_ACK" || MASK_RC=$?
rec "classified channel masking failures=$MASK_RC"
if [ "$MASK_RC" -ne 0 ]; then
  fail "$MASK_RC classified host IPC channel(s) could not be masked (see ipc-mask.txt) -- phase C NOT started" \
    "$F2AI_ISO_RC_ESTABLISH"
fi

# --------------------------------------------------- N3-1/N3-2 FD inventory
fd_inventory() {
  local out="$1" p fd tgt
  : >"$out"
  for p in "/proc/$SHELL_PID/fd/"*; do
    [ -e "$p" ] || continue
    fd="${p##*/}"; tgt="$(readlink "$p" 2>/dev/null || echo UNREADABLE)"
    printf '%s\t%s\n' "$fd" "$tgt" >>"$out"
  done
}
if { [ "$FAULT" = fd ] || [ "$FAULT" = fd-keep ]; } && [ "$FAULT_ACK" = 1 ]; then
  # N3-2 controlled counterexample: a deliberately inherited descriptor that is
  # NOT close-on-exec and connects to NO external network (a local regular file).
  printf 'inherited-fd-counterexample %s\n' "$NONCE" >"$EVID/fd-bait.txt"
  exec 9<"$EVID/fd-bait.txt"
  rec "FAULT=$FAULT: opened bait fd 9 -> $EVID/fd-bait.txt"
fi
fd_inventory "$EVID/fd-before.txt"
if [ "$FAULT" != fd-keep ] || [ "$FAULT_ACK" != 1 ]; then
  for p in "/proc/$SHELL_PID/fd/"*; do
    [ -e "$p" ] || continue
    fd="${p##*/}"
    case "$fd" in 0|1|2|255) continue ;; esac
    case "$fd" in ''|*[!0-9]*) continue ;; esac
    eval "exec ${fd}>&-" 2>/dev/null || true
  done
fi
fd_inventory "$EVID/fd-after.txt"
# Closing is best effort; the VERIFICATION is not. Anything left that is a
# socket or an unexpected descriptor fails the run here and again in phase C.
STRAY=0
while IFS=$'\t' read -r fd tgt; do
  case "$fd" in 0|1|2) case "$tgt" in socket:*) STRAY=1;
      printf 'stdio-is-socket %s %s\n' "$fd" "$tgt" >>"$EVID/fd-violations.txt" ;; esac
    continue ;;
    255) continue ;;
  esac
  STRAY=1
  printf 'unexpected-fd %s %s\n' "$fd" "$tgt" >>"$EVID/fd-violations.txt"
done <"$EVID/fd-after.txt"
if [ "$STRAY" -ne 0 ] && { [ "$FAULT" != fd-keep ] || [ "$FAULT_ACK" != 1 ]; }; then
  fail "file descriptors survived cleanup (see fd-violations.txt)" "$F2AI_ISO_RC_FD"
fi

# --------------------------------------- d4: the UNFORGEABLE boundary marker.
# The guard that runs inside phase D must be able to tell the boundary EXISTS.
# A nonce alone is forgeable, so the marker pairs three things that only a real
# establishment can produce together: the launcher's nonce (also exported in the
# environment, and the two must correspond), the subtree's network-namespace id,
# and the host's. The consumer re-reads /proc/self/ns/net and requires it to
# equal SUB and differ from HOST -- a claim no in-process patch can fake
# (M-G1-02: a monkey patch does not even reach descendants, let alone the
# kernel's namespace identity).
{
  printf 'nonce=%s\n'      "$NONCE"
  printf 'sub_netns=%s\n'  "$SUB_NETNS"
  printf 'host_netns=%s\n' "$HOST_NETNS"
  printf 'utc=%s\n'        "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$EVID/launch.nonce"

{
  printf 'CTRL_PID=%s\n' "$CTRL_PID"
  printf 'CTRL_NS=%s\n'  "$CTRL_NS"
  printf 'CTRL_NS_PATH=/proc/%s/ns/net\n' "$CTRL_PID"
  printf 'CTRL_PRE_RC=%s\n' "$CTRL_PRE_RC"
  printf 'SUB_NETNS=%s\n' "$SUB_NETNS"
  printf 'SUB_USERNS=%s\n' "$SUB_USERNS"
} >>"$PARAMS"

# ------------------------------------------------------ N2-1/N2-2 privilege drop
SAFE_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
[ -n "$TOOL_PATH" ]   && SAFE_PATH="$TOOL_PATH:$SAFE_PATH"
[ -n "$PATH_PREFIX" ] && SAFE_PATH="$PATH_PREFIX:$SAFE_PATH"
printf 'SAFE_PATH=%s\n' "$SAFE_PATH" >>"$EVID/env-policy.txt"

ENVV=(env -i
  PATH="$SAFE_PATH" HOME="$TARGET_HOME" PWD="$TARGET_CWD" TMPDIR=/tmp
  LANG=C.UTF-8 TZ=UTC CI=true TERM=dumb FORCE_COLOR=0
  F2AI_ISO_PARAMS="$PARAMS" F2AI_ISO_EVID="$EVID" F2AI_ISO_NONCE="$NONCE")

DROP=(setpriv --reuid="$TARGET_UID" --regid="$TARGET_GID" --clear-groups
      --inh-caps=-all --bounding-set=-all --no-new-privs)
[ "$SETPRIV_AMBIENT" = yes ] && DROP+=(--ambient-caps=-all)

cd "$TARGET_CWD"
rec "DROP mode=$MODE target_uid=$TARGET_UID target_gid=$TARGET_GID ambient=$SETPRIV_AMBIENT"
if [ "$MODE" = userns ]; then
  # Secondary path: only uid 0 is mapped, so the UID cannot change. capsh empties
  # every capability set instead; "uid is 0" and "has CAP_SYS_ADMIN" are stated
  # separately (N2-4) and BOTH are measured in phase C from /proc/self/status.
  exec "${ENVV[@]}" setpriv --reuid=0 --regid=0 --clear-groups --inh-caps=-all \
    --bounding-set=-all --no-new-privs -- \
    capsh --caps= -- -c 'exec bash "$0" "$@"' \
    "$HERE/netns-phases.sh" "$PARAMS" -- "$@"
else
  exec "${ENVV[@]}" "${DROP[@]}" -- bash "$HERE/netns-phases.sh" "$PARAMS" -- "$@"
fi
