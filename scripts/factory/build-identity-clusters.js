#!/usr/bin/env node
/**
 * PR-C2 4/4-bake caller for the identity-cluster crate (the WIRE that makes the
 * DORMANT crate actually RUN on every full recompute). Design:
 * IDENTITY_LAYER_DESIGN_v3 E [D2] -- full connected-component recompute each 4/4.
 *
 * INPUT  (gate 3): ONLY PR-C1 SAME_AS assertion shards. The crate reader consumes
 *   `assertions-NN.jsonl.zst` and keeps ONLY `relation == "SAME_AS"` rows
 *   (MANIFESTATION_OF can never fold, C.3). No other input source is read here.
 * OUTPUT (gate 4): ONLY the cluster-assignment artifact
 *   (output/cache/identity/cluster-assignment.jsonl.zst). This is producer-internal
 *   state (NOT in the upload R2_PREFIX_FILTER allow-list) -- it never lands on a
 *   serve surface, mesh, or any other artifact.
 * FAILURE (gate 5): if buildIdentityClusters errors (MAX_PASSES_EXCEEDED /
 *   PARTITION_SKEW / NON_SINGLETON_FLOOR / read error) the bake HARD-FAILS here
 *   (exit 1) -- never catch-and-continue, never silent skip.
 * NO global id-map (gate 6): the crate hash-partitions by canonical_id; this
 *   caller passes K and never builds a corpus-wide id->int table.
 *
 * The crate is bake-PRODUCER-only with no JS fallback (an identity fold can only
 * be Rust-exact), so absence of the .node is itself a HARD fail. ASCII-only.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const OUTPUT_DIR = process.env.OUTPUT_DIR || './output';
const CACHE_DIR = process.env.CACHE_DIR || path.join(OUTPUT_DIR, 'cache');
// PR-C1 producer path (assertion-generator.js writes here; restored into the 4/4
// workspace via the cycle-output cache / R2 state/cycle-output/).
const ASSERTION_DIR = path.join(CACHE_DIR, 'assertions');
const WORK_DIR = path.join(CACHE_DIR, 'identity-work');
const OUT_DIR = path.join(CACHE_DIR, 'identity');
const ARTIFACT = path.join(OUT_DIR, 'cluster-assignment.jsonl.zst');

// K = hash-partition count for the streaming CC pass (independent of the D5/96
// identity-graph.bin router; just bounds resident memory to ~N/K). max_passes is
// the label-prop safety cap -> exceeding it honest-fails (gate 2).
const K = Number.parseInt(process.env.IDENTITY_CLUSTER_K || '96', 10);
const MAX_PASSES = Number.parseInt(process.env.IDENTITY_CLUSTER_MAX_PASSES || '200', 10);

function loadCrate() {
    const p = '../../rust/identity-cluster/identity-cluster-rust.node';
    try {
        return require(p);
    } catch (e) {
        console.error(`[IDENTITY] FATAL: identity-cluster-rust.node failed to load: ${e.message}`);
        console.error('[IDENTITY] The crate is bake-producer-only with no JS fallback; refusing to continue.');
        process.exit(1);
    }
}

/** Count PR-C1 SAME_AS shards present (assertions-NN.jsonl.zst). */
function countAssertionShards(dir) {
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter((f) => /^assertions-\d+\.jsonl\.zst$/.test(f)).length;
}

function main() {
    const shardCount = countAssertionShards(ASSERTION_DIR);
    if (shardCount === 0) {
        // Conditional-producer case: PR-C1 did not run this cycle (its 3/4 dispatch
        // is wired separately). This is NOT a buildIdentityClusters error -- there is
        // simply nothing to fold. Skip LOUDLY (mirrors verify-assertions.js); do NOT
        // fabricate an empty cluster artifact and do NOT fail a non-identity bake.
        console.log(`[IDENTITY] SKIP: no PR-C1 SAME_AS shards at ${ASSERTION_DIR} (producer did not run this cycle).`);
        return;
    }

    const idc = loadCrate();
    if (typeof idc.buildIdentityClusters !== 'function') {
        console.error('[IDENTITY] FATAL: buildIdentityClusters missing from the loaded .node.');
        process.exit(1);
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.rmSync(WORK_DIR, { recursive: true, force: true }); // fresh scratch each recompute

    console.log(`[IDENTITY] Building identity clusters from ${shardCount} SAME_AS shard(s) (K=${K}, maxPasses=${MAX_PASSES})...`);
    let summary;
    try {
        // GATE 5: any thrown error (MAX_PASSES_EXCEEDED / PARTITION_SKEW /
        // NON_SINGLETON_FLOOR / read error) propagates and HARD-fails the bake.
        summary = idc.buildIdentityClusters(ASSERTION_DIR, WORK_DIR, OUT_DIR, K, MAX_PASSES);
    } catch (e) {
        console.error(`[IDENTITY] FATAL: buildIdentityClusters failed: ${e.message}`);
        console.error('[IDENTITY] Refusing to emit partial/untrustworthy clusters -- failing the 4/4 bake.');
        process.exit(1);
    }

    if (!fs.existsSync(ARTIFACT)) {
        console.error(`[IDENTITY] FATAL: cluster artifact not written at ${ARTIFACT}.`);
        process.exit(1);
    }
    console.log(
        `[IDENTITY] OK: edges=${summary.edges} nodes=${summary.nodes} clusters=${summary.clusters} ` +
        `nonSingleton=${summary.nonSingletonClusters} passes=${summary.passes} converged=${summary.converged} ` +
        `maxPartNodes=${summary.maxPartitionNodes} rows=${summary.assignmentRows}`
    );
    console.log(`[IDENTITY] Artifact: ${ARTIFACT}`);
    fs.rmSync(WORK_DIR, { recursive: true, force: true }); // drop scratch spill
}

main();
