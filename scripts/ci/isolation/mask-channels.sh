#!/usr/bin/env bash
#
# Free2AITools work order N -- classified host-IPC channel masking (ruling B,
# the strict option). SOURCED by netns-establish.sh while it is still privileged
# and inside its own mount namespace.
#
# THE RULE, AND IT IS THE POINT: a classified channel that EXISTS must be masked
# successfully. If the masking returns rc != 0 the caller aborts at the
# ESTABLISH stage with exit 71 and phase C never runs. "The subtree never
# touched a live container-runtime or credential socket" is then a CONSTRUCTIVE
# fact -- established before anything ran -- instead of something an audit
# explains afterwards. Nothing here probes, connects to, or otherwise touches a
# live socket: the only operations are stat and mount.
#
# A path that does not exist is recorded ABSENT and needs no masking. That is
# also constructive, not an excuse.
#
# Non-classified channels are NOT touched here at all; they are inventoried
# read-only at the final identity and are never a pass/fail input.
#
# The channel list is read from classified-channels.tsv. Nothing in this file
# hardcodes a channel path or pattern.

F2AI_MASK_SEARCH_ROOTS="/run /var/run /tmp"

# _f2ai_mask_one <method> <path> -> rc of the mount, 0 if nothing to do
_f2ai_mask_one() {
  local method="$1" target="$2" rc=0
  case "$method" in
    TMPFS_DIR) mount -t tmpfs -o ro,size=4k tmpfs "$target" || rc=$? ;;
    BIND_NULL) mount --bind /dev/null "$target" || rc=$? ;;
    *) rc=90 ;;
  esac
  return "$rc"
}

# f2ai_mask_classified <tsv> <evid> <fault> <fault_ack>
# Writes <evid>/ipc-mask.txt. Returns non-zero if ANY classified channel that
# exists could not be masked.
f2ai_mask_classified() {
  local tsv="$1" evid="$2" fault="$3" fault_ack="$4"
  local report="$evid/ipc-mask.txt"
  local class match target mask rationale rc failures=0 forced=0
  : >"$report"
  if [ ! -f "$tsv" ]; then
    printf 'LIST_MISSING %s\n' "$tsv" >>"$report"
    return 1
  fi

  # --- literal paths -------------------------------------------------------
  while IFS=$'\t' read -r class match target mask rationale; do
    case "$class" in ''|\#*) continue ;; esac
    [ "$class" = CLASSIFIED ] || continue
    [ "$match" = PATH ] || continue
    if [ ! -e "$target" ]; then
      printf 'ABSENT\t%s\t(no masking required)\n' "$target" >>"$report"
      continue
    fi
    # b4 counterexample, bookkeeping variant: mark exactly one masking failed
    # without touching the channel. It proves the ABORT WIRING on any runner,
    # including one where every classified path happens to be absent. It does
    # NOT exercise mount(8), which is why the mask-real variant below exists.
    # The knob can only ADD a failure, so it can never weaken the boundary -- a
    # forced failure aborts the run at establish, it does not let anything
    # through.
    if [ "$fault" = mask ] && [ "$fault_ack" = 1 ] && [ "$forced" -eq 0 ]; then
      forced=1
      printf 'FORCED_FAILURE\t%s\t%s\t(b4 counterexample)\n' "$target" "$mask" >>"$report"
      failures=$((failures + 1))
      continue
    fi
    rc=0
    _f2ai_mask_one "$mask" "$target" || rc=$?
    if [ "$rc" -eq 0 ]; then
      printf 'MASKED\t%s\t%s\n' "$target" "$mask" >>"$report"
    else
      printf 'MASK_FAILED\t%s\t%s\trc=%s\n' "$target" "$mask" "$rc" >>"$report"
      failures=$((failures + 1))
    fi
  done <"$tsv"

  # --- b4 counterexample, REAL variant -------------------------------------
  # The bookkeeping knob above never calls mount(8), so on its own it leaves the
  # question "would a genuine masking failure be detected?" untested. This one
  # answers it the way the ruling's example does -- with a mount point that
  # cannot take the mask. The bait is a REGULAR FILE and the method is
  # TMPFS_DIR, so the kernel refuses ("mount point is not a directory") and
  # _f2ai_mask_one returns mount's own rc through the ordinary code path.
  # It is treated as CLASSIFIED, so the run must abort at establish.
  # ADD-ONLY, in both directions: if the mount unexpectedly SUCCEEDS that is
  # recorded as a vacuous fault and still counted as a failure, so the knob can
  # never be the reason a run continues.
  if [ "$fault" = mask-real ] && [ "$fault_ack" = 1 ]; then
    local bait="$evid/mask-bait-not-a-directory"
    printf 'b4 real-mount-failure bait: a regular file, never a channel\n' >"$bait"
    rc=0
    _f2ai_mask_one TMPFS_DIR "$bait" || rc=$?
    if [ "$rc" -eq 0 ]; then
      printf 'REAL_FAULT_DID_NOT_FAIL\t%s\tTMPFS_DIR\t(b4 real variant was vacuous here)\n' \
        "$bait" >>"$report"
    else
      printf 'MASK_FAILED\t%s\tTMPFS_DIR\trc=%s\t(b4 real mount failure)\n' \
        "$bait" "$rc" >>"$report"
    fi
    failures=$((failures + 1))
  fi

  # --- sockets discovered under the search roots, matched against PATTERNs --
  local discovered="$evid/ipc-discovered.txt"
  # shellcheck disable=SC2086
  find $F2AI_MASK_SEARCH_ROOTS -maxdepth 3 -type s 2>/dev/null >"$discovered" || true
  local sock
  while IFS= read -r sock; do
    [ -n "$sock" ] || continue
    [ -S "$sock" ] || continue
    local hit=""
    while IFS=$'\t' read -r class match target mask rationale; do
      case "$class" in ''|\#*) continue ;; esac
      [ "$class" = CLASSIFIED ] || continue
      [ "$match" = PATTERN ] || continue
      if printf '%s' "$sock" | grep -Eq -- "$target"; then hit="$mask"; break; fi
    done <"$tsv"
    if [ -z "$hit" ]; then
      printf 'RECORD_ONLY\t%s\t(not classified; never probed)\n' "$sock" >>"$report"
      continue
    fi
    if grep -F -q "MASKED	$sock	" "$report" 2>/dev/null; then continue; fi
    rc=0
    _f2ai_mask_one "$hit" "$sock" || rc=$?
    if [ "$rc" -eq 0 ]; then
      printf 'MASKED\t%s\t%s\t(pattern)\n' "$sock" "$hit" >>"$report"
    else
      printf 'MASK_FAILED\t%s\t%s\trc=%s\t(pattern)\n' "$sock" "$hit" "$rc" >>"$report"
      failures=$((failures + 1))
    fi
  done <"$discovered"

  printf 'SUMMARY\tclassified_mask_failures=%s\n' "$failures" >>"$report"
  return "$failures"
}
