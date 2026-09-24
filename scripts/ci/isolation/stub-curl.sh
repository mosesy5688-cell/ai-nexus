#!/usr/bin/env bash
#
# Free2AITools work order N -- P-1 stub binary source, copied into a temporary
# PATH directory by the counterexample driver and installed there as `curl`.
#
# WHY THIS EXISTS (the 2026-09-19 incident, not a hypothetical): a stub `curl`
# and a stub `jq` sat in the same place and NEITHER was selected. `jq` failed
# loudly because the machine had no system `jq`; `curl` resolved SILENTLY to the
# real binary and emitted 12 production requests. "There is a same-named system
# command to fall back to" is exactly what makes the failure silent -- so this
# stub never behaves like curl, for any argument, ever.
#
# It does exactly two things:
#   1. records its own argv for the P-1 (c) sentinel check
#   2. refuses everything else with a non-zero exit, so a caller that reaches it
#      expecting curl fails loudly instead of quietly doing nothing
set -Eeuo pipefail

if [ -n "${F2AI_ISO_SENTINEL_LOG:-}" ]; then
  printf '%s argv:%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$F2AI_ISO_SENTINEL_LOG"
fi

if [ "${1-}" = "--f2ai-iso-sentinel" ]; then
  # Side-effect-free sentinel invocation used by f2ai_stub_verify.
  exit 0
fi

printf 'f2ai isolation stub: refusing to act as curl (argv: %s)\n' "$*" >&2
exit 66
