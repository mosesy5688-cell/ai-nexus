# Free2AITools work order N -- shared exit-code vocabulary for the isolation
# launcher. Sourced by every stage so a reader can tell WHERE a run stopped.
#
# Ruling B3 requires the isolation result and the test result to be reported
# SEPARATELY. A distinct code per pre-gate is what makes that possible without
# guessing: 70-76 can only be produced by the launcher's own gates, never by the
# program under test, and 124 is reserved by timeout(1). The program under test
# keeps its own exit code verbatim.
#
# These codes are ALSO the process-execution evidence used by the F1/F2
# counterexamples: "marker absent" plus "stopped at gate 71/74" locates the
# abort at the pre-gate. Neither is asserted from a log line alone (N4-6).
F2AI_ISO_RC_PRECHECK=70    # outer preconditions / tool + option probe failed
F2AI_ISO_RC_ESTABLISH=71   # namespace establishment failed (or lo/control-ns)
F2AI_ISO_RC_DROP=72        # privilege drop or final-identity check failed
F2AI_ISO_RC_FD=73          # file-descriptor cleanup verification failed
F2AI_ISO_RC_SELFTEST=74    # phase C self-test (refusal control matrix) failed
F2AI_ISO_RC_USAGE=75       # launcher invoked incorrectly
F2AI_ISO_RC_STUB=76        # P-1 stub identity verification failed after switch
F2AI_ISO_RC_TIMEOUT=124    # timeout(1) overall deadline -- never remapped
