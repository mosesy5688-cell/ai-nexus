#!/usr/bin/env bash
#
# Free2AITools work order N -- terminal records and the single attribution
# artifact (ruling C, c5). SOURCED by netns-launch.sh; it must not set shell
# options for its caller and it must not exit.
#
# WHY IT IS A SEPARATE FILE: netns-launch.sh reached the CES monolith limit
# (MAX_LINES=250) once this ran on every terminal path. The answer is to split
# by concern, not to delete the explanations -- the launcher keeps the boundary
# narrative, this file owns "write what happened, then emit the one artifact".
#
# WHY IT RUNS ON EVERY PATH: attribution.txt is the file CI reads its
# classification from, so it has to exist for every way the launcher can end,
# INCLUDING the gates that stop before establishment. If it were produced only
# on the normal tail it would be missing exactly when the run failed earliest,
# and the isolation-vs-test classification would fall back to the exit code --
# which c1 rules out, because 70-76 are not reserved and the program under test
# may return any of them.
#
# IT CANNOT CHANGE AN OUTCOME. The generator's status is recorded and discarded,
# and this function always returns 0; the caller exits with its own verbatim
# code. Evidence collection is never allowed to turn a failure into a success.

# f2ai_finalize <rc>: record the launcher's verbatim status, emit
# attribution.txt, and echo it so it appears in the CI log. Always returns 0.
f2ai_finalize() {
  printf '%s\n' "$1" >"$EVID/launcher.rc"
  if command -v node >/dev/null 2>&1; then
    node "$HERE/attribute.mjs" "$EVID" >>"$LOG" 2>&1 || rec "attribution generator rc=$?"
  else
    rec "attribution generator NOT RUN: node is not resolvable"
  fi
  if [ -f "$EVID/attribution.txt" ]; then cat "$EVID/attribution.txt"; fi
  return 0
}
