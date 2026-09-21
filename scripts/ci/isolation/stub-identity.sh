#!/usr/bin/env bash
#
# Free2AITools work order N -- P-1 stub identity verification, re-runnable.
#
# P-1 (offline preconditions, 2026-09-19) requires, in the SAME shell, PATH and
# working directory the real script uses, and AGAIN after every step group that
# may change PATH or switch environment (N5-5 makes this explicit for the
# privilege switch):
#   a) the resolved executable path points at the stub, not the system binary
#   b) the stub's byte count and hash match
#   c) one side-effect-free sentinel argv record proves the call landed on it
# and that shell functions, aliases, the command hash cache and absolute-path
# invocation are all part of the resolution check -- `command -v` alone is not
# enough (`type -a` / `declare -F` / `hash -t`).
#
# This file is SOURCED, never executed as a subprocess: verifying resolution in
# a different shell would repeat exactly the v1 errexit mistake the preconditions
# file names. It is fail-closed: any mismatch returns non-zero and the caller
# must stop, never continue.
#
# Manifest format, one tool per line, TAB separated:
#   name <TAB> expected_path <TAB> expected_sha256 <TAB> expected_bytes

f2ai_stub_verify() {
  local manifest="$1" outdir="$2" tag="$3" nonce="$4"
  local name want_path want_sha want_bytes got_path got_sha got_bytes rc=0
  local report="$outdir/stub-identity-$tag.txt"
  : >"$report"
  if [ -z "$manifest" ]; then
    printf 'NO_MANIFEST tag=%s: no stub is in play for this run; nothing asserted\n' \
      "$tag" >>"$report"
    return 0
  fi
  if [ ! -f "$manifest" ]; then
    printf 'MANIFEST_MISSING %s\n' "$manifest" >>"$report"
    return 1
  fi
  hash -r
  while IFS=$'\t' read -r name want_path want_sha want_bytes; do
    [ -n "$name" ] || continue
    case "$name" in \#*) continue ;; esac

    got_path="$(command -v "$name" 2>/dev/null || true)"
    printf 'tool=%s command-v=%s want=%s\n' "$name" "${got_path:-NONE}" "$want_path" >>"$report"
    if [ "$got_path" != "$want_path" ]; then
      printf 'FAIL %s resolution mismatch\n' "$name" >>"$report"; rc=1; continue
    fi

    # Shell functions, aliases and the hash cache can all silently win over PATH.
    if declare -F "$name" >/dev/null 2>&1; then
      printf 'FAIL %s is a shell function\n' "$name" >>"$report"; rc=1; continue
    fi
    { type -a "$name" || true; } >>"$report" 2>&1
    if type -a "$name" 2>/dev/null | grep -qE 'is aliased to|is a shell builtin'; then
      printf 'FAIL %s is an alias or builtin\n' "$name" >>"$report"; rc=1; continue
    fi
    "$name" --f2ai-iso-sentinel "$nonce" >/dev/null 2>&1 || true
    printf 'hash-t=%s\n' "$(hash -t "$name" 2>/dev/null || echo NONE)" >>"$report"
    if [ "$(hash -t "$name" 2>/dev/null || echo NONE)" != "$want_path" ]; then
      printf 'FAIL %s hash cache points elsewhere\n' "$name" >>"$report"; rc=1; continue
    fi

    got_bytes="$(stat -c %s "$want_path" 2>/dev/null || echo -1)"
    got_sha="$(sha256sum "$want_path" 2>/dev/null | cut -d' ' -f1 || true)"
    printf 'bytes=%s want_bytes=%s sha=%s want_sha=%s\n' \
      "$got_bytes" "$want_bytes" "${got_sha:-NONE}" "$want_sha" >>"$report"
    if [ "$got_bytes" != "$want_bytes" ] || [ "$got_sha" != "$want_sha" ]; then
      printf 'FAIL %s identity mismatch\n' "$name" >>"$report"; rc=1; continue
    fi

    # (c) the sentinel call above must have landed ON THE STUB. The stub records
    # its own argv; a real binary would not, which is what makes this
    # non-vacuous when the manifest is pointed at a system binary on purpose.
    if [ ! -f "$outdir/stub-sentinel.log" ] || \
       ! grep -F -q "$nonce" "$outdir/stub-sentinel.log"; then
      printf 'FAIL %s sentinel argv record absent (call did not land on the stub)\n' \
        "$name" >>"$report"; rc=1; continue
    fi
    printf 'PASS %s\n' "$name" >>"$report"
  done <"$manifest"
  return "$rc"
}
