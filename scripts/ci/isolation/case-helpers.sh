#!/usr/bin/env bash
#
# Free2AITools work order N -- shared expectations for the counterexample and
# attribution drivers. SOURCED, never executed: it must not set shell options
# for its caller, and the drivers must keep their own real shell semantics.
#
# Every helper here RECORDS a failure and returns; none of them exits. The
# drivers exit with their accumulated failure count, so one bad expectation
# cannot mask the rest, and nothing can turn a failure into a success.

note() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
bad()  { FAILED=$((FAILED + 1)); printf 'EXPECTATION FAILED: %s\n' "$*" >&2; }

expect_rc()      { if [ "$1" -ne "$2" ]; then bad "$3: expected rc $2, observed $1"; fi; }
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

# attr_get <key> -> the value from THIS case's attribution.txt, or the literal
# string NO_ATTRIBUTION_FILE. Ruling c5: CI reads the verdict from this one
# file, so the drivers assert against it rather than re-deriving anything.
attr_get() {
  if [ ! -f "$CASE_EVID/attribution.txt" ]; then printf 'NO_ATTRIBUTION_FILE'; return; fi
  sed -n "s/^$1=//p" "$CASE_EVID/attribution.txt" | head -1
}

expect_attr() {
  local got
  got="$(attr_get "$1")"
  if [ "$got" != "$2" ]; then bad "$3: attribution.txt $1='$got', expected '$2'"; fi
}
