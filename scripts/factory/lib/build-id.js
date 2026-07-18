/**
 * Bake/publish build-id — the SINGLE coherence token stamped into BOTH the
 * id-index.bin header (id-index-generator.js) and shards_manifest.json
 * (pack-finalizer.js) within ONE pack-db.js process.
 *
 * Read-path contract (entity-absence-oracle.ts): id-index may prove ABSENCE only
 * when the index build-id and the served manifest build-id are verified coherent
 * for the same request. The two writers therefore MUST stamp the identical value;
 * the only way to guarantee that is to capture it ONCE per process and thread it
 * to both. deriveBuildId() is that single capture (call once in packDatabase()).
 *
 * Source (most-robust-available, never runtime-generated on the read side):
 *   - GITHUB_RUN_ID : the existing per-bake CI run id (already the provenance
 *     job_id in r2-uploader.js / l5-manifest.js). UNIQUE per distinct bake, so it
 *     distinguishes two SEPARATE cron runs of unchanged main — which a bare commit
 *     SHA cannot. This is the founder-approved "existing bake-run id".
 *   - GITHUB_RUN_ATTEMPT : (R5 MF-3) folded in as `a<attempt>`. GitHub "Re-run
 *     jobs" REUSES GITHUB_RUN_ID, so run_id ALONE cannot distinguish a re-attempt
 *     from its original — a re-bake would mint the SAME build_id and overwrite a
 *     write-once cycle prefix. run_attempt makes a re-attempt mint a DISTINCT
 *     build_id -> distinct cycle prefix -> no write-once collision. Precedent:
 *     GITHUB_RUN_ATTEMPT already anchors identity at aggregate-handoff.mjs:616.
 *   - GITHUB_SHA (short) : bake commit, appended for human traceability. Stable
 *     within a run, so it never desyncs the two writers.
 *   - local fallback : `local-<epoch>` for non-CI bakes (still a single captured
 *     value, never per-writer).
 *
 * The value is OPAQUE to the reader: it only ever does an exact === comparison of
 * the index's stamped id vs the manifest's stamped id. No structure is parsed.
 */

/**
 * Derive the one build-id for this pack process. Call ONCE in packDatabase() and
 * pass the result to both finalizePack and generateIdIndex.
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string} non-empty build-id
 */
export function deriveBuildId(env = process.env) {
    const runId = (env.GITHUB_RUN_ID || '').trim();
    const attempt = (env.GITHUB_RUN_ATTEMPT || '').trim() || '1';
    const sha = (env.GITHUB_SHA || '').trim();
    if (runId) {
        // run-id + run-attempt are the coherence + re-attempt-uniqueness anchors;
        // short sha is decorative traceability. A GitHub re-run (same run_id, new
        // run_attempt) therefore mints a DISTINCT build_id (R5 MF-3).
        const short = sha ? `-${sha.slice(0, 12)}` : '';
        return `run-${runId}-a${attempt}${short}`;
    }
    // Non-CI / local bake: a single captured epoch (still one value for both
    // writers — never per-writer Date.now()).
    return `local-${Date.now()}`;
}
