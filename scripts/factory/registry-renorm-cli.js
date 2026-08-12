#!/usr/bin/env node
/**
 * OP-GR-B: one-time re-normalisation of the giant-`tags` cohort in the WORKING
 * registry (ruling D-2026-0810-418, finding FINDING-GR-1). THIN ENTRY POINT --
 * all orchestration lives in lib/registry-renorm-run.js so that every terminal
 * path is testable without R2 or the production key.
 *
 * POSITION IN THE CASCADE. Runs inside 1/4 factory-harvest AFTER the registry
 * is loaded (GHA-cache restore, then r2-registry-restore.js) and BEFORE
 * merge-batches.js consumes it. That is the ruling's chosen authority target:
 * the registry the pipeline actually loaded, not any one of the five divergent
 * R2 mirrors. It deliberately does NOT touch the restore/precedence logic --
 * washing data and changing precedence in the same cycle would alias the two
 * variables, which the ruling prohibits (FINDING-PREC-1 is scheduled elsewhere).
 *
 * TRIGGER. The Founder-set repository variable OP_GR_B_RENORM, exercised by the
 * next NATURAL cascade. There is no workflow_dispatch path. With the flag unset
 * this process reads nothing, writes nothing, and returns 0, so cron behaviour
 * is byte-equivalent to today.
 *
 * DISCLOSURE. Logs and artifacts carry ids and byte counts only -- never record
 * content, never a tag value, never a secret.
 */

import fs from 'fs';
import { createR2Client } from './lib/r2-helpers.js';
import { runRenorm, exitCodeFor } from './lib/registry-renorm-run.js';

const CENSUS = JSON.parse(fs.readFileSync(
    new URL('./lib/op-gr-b-giant-cohort.json', import.meta.url), 'utf8'));

// REHEARSAL-1 (D-2026-0812-422): `--reconcile-only` runs the census comparison
// and writes the dry-run manifest, then stops -- no snapshot, no staging, no
// swap, no marker write. It is NOT gated on the Founder variable, because a
// rehearsal must be runnable BEFORE the operation is armed and, by construction,
// cannot write anything. Its authorisation is the manual dispatch itself.
const reconcileOnly = process.argv.includes('--reconcile-only');

const result = await runRenorm({
    s3: createR2Client(),
    bucket: process.env.R2_BUCKET || 'ai-nexus-assets',
    censusDoc: CENSUS,
    registryDir: `${process.env.CACHE_DIR || './cache'}/registry`,
    artifactDir: process.env.OP_GR_B_ARTIFACT_DIR || 'op-gr-b',
    reconcileOnly,
    flagEnabled: reconcileOnly || process.env.OP_GR_B_RENORM === 'true',
    snapshotMaxBytes: parseInt(process.env.OP_GR_B_SNAPSHOT_MAX_BYTES || String(2 * 1024 * 1024 * 1024), 10),
    context: {
        run_id: process.env.GITHUB_RUN_ID || null,
        run_attempt: process.env.GITHUB_RUN_ATTEMPT || null,
        head_sha: process.env.GITHUB_SHA || null,
    },
    log: (m) => console.log(`[OP-GR-B] ${m}`),
    loud: (m) => console.error(`[OP-GR-B] ${m}`),
});

console.log(`[OP-GR-B] outcome=${result.outcome}`);

// Exit-code policy lives in exitCodeFor() so it is pinned by an exhaustive
// unit test rather than by a ternary nobody exercises. VERIFICATION_FAILED is
// the only non-zero terminal; see the predicate for why.
process.exit(exitCodeFor(result.outcome));
