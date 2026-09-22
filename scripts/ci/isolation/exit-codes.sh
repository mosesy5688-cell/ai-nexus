# Free2AITools work order N -- shared exit-code vocabulary for the isolation
# launcher. Sourced by every stage.
#
# CORRECTION (ruling C, c1). An earlier version of this comment claimed 70-76
# "can only be produced by the launcher's own gates, never by the program under
# test". THAT WAS FALSE. Nothing reserves these numbers: the program under test
# is free to exit 70, 71, 74 or 124, and it does so in the c4 discriminating
# test on purpose.
#
# The codes are NOT remapped to make attribution easier. Verbatim exit-code
# propagation is an INTENTIONAL HONESTY PROPERTY -- evidence collection must
# never turn a failure into a success, and a remap is exactly the kind of
# rewriting that would let it. Honesty wins; attribution has to work some other
# way.
#
# SO: THE EXIT CODE IS NOT THE PRIMARY CRITERION FOR ATTRIBUTION. It is a hint.
# Attribution is decided from the RECORDS each stage writes as it passes --
# phaseC.rc, phaseD.launched, phaseD.rc, launcher.rc, and the explicitly
# recorded timeout source -- and is emitted as a single machine-readable
# attribution.txt by attribute.mjs. Ruling B3's separation of "isolation
# failed" from "the test failed" is read from that file, never from the number
# alone. See attribute.mjs for the decision table.
F2AI_ISO_RC_PRECHECK=70    # outer preconditions / tool + option probe failed
F2AI_ISO_RC_ESTABLISH=71   # establishment failed (ns, lo, control-ns, masking)
F2AI_ISO_RC_DROP=72        # privilege drop or final-identity check failed
F2AI_ISO_RC_FD=73          # file-descriptor cleanup verification failed
F2AI_ISO_RC_SELFTEST=74    # phase C self-test (refusal control matrix) failed
F2AI_ISO_RC_USAGE=75       # launcher invoked incorrectly
F2AI_ISO_RC_STUB=76        # P-1 stub identity verification failed after switch
F2AI_ISO_RC_TIMEOUT=124    # timeout(1)'s own code -- never remapped, and never
                           # read as proof of a timeout on its own (see c3)
