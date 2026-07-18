/**
 * R5 EXHAUSTIVE VERIFY + MANIFEST CENSUS + POISON QUARANTINE (Phase 2, MF-2).
 *
 * PRODUCTION EXECUTION FENCE (Founder D-2026-0718-352): verifyCycleExhaustive is a
 * no-op unless an explicit mode:'stage_enabled' + injected deps are passed (test
 * dependency injection). No production caller enables it; the workflow VERIFY step
 * runs main() which is a fenced no-op. This module NEVER writes data/current.json,
 * NEVER deletes, NEVER mutates the served set. Its ONLY write is a create-only
 * quarantine record on a proven poison blob (a key whose stored bytes do not hash
 * to the key) — a write-once key that is never overwritten (recover via new build_id).
 */
import { pathToFileURL } from 'url';
import { STAGE_MODE, stagingEnabled, sha256, R5StagingError } from './lib/r5-staging.js';
import { RANKINGS_DB_NAMES, RANKINGS_DB_COUNT } from '../../src/constants/rankings-groups.js';

/**
 * PHASE-3 ACTIVATION BLOCKER (retained, NOT resolved by this PR). There is NO
 * production cycle manifest under Phase 2: pack-finalizer.finalizePack emits none,
 * and pack-finalizer's emitCycleManifest is a local / dependency-injection test
 * substrate with ZERO production callers. A finalize-time emit could never satisfy
 * the census below, because pack-db.js generates hot-shard.bin + vector-core.bin,
 * cluster-ann, meta-anchors (meta-knowledge.db / meta-report.db), term_index/** and
 * id-index.bin AFTER finalizePack returns -- so no position inside finalizePack is a
 * valid end-of-pack integrity barrier. This PR does NOT activate staging: STAGE +
 * VERIFY are execution-fenced no-ops, so nothing fails in production. A DI test
 * fixture carrying a complete manifest proves the census logic ONLY -- it does NOT
 * prove that any production manifest is complete. Activation requires introducing a
 * true end-of-pack barrier after every served artifact is final, plus the transport
 * for it: that is Phase 3 and needs a separate Founder activation ruling.
 */

// Always-present served singletons every cycle manifest MUST enumerate. id-index/
// hot-shard/vector-core ship in the R2 serving prefix; meta-knowledge.db (knowledge
// .astro + concepts.ts) and meta-report.db (trends.astro) are built unconditionally
// by meta-anchors.js (even empty), so they are unconditional here too.
// D-395 reconciliation: shards_manifest.json is a PUBLIC served singleton (the
// reader's shard + partitions authority; pack-finalizer is its ONLY writer and the
// 4/4 pre-publication gate requires it), so the cycle manifest must enumerate it.
// R5 only ever HASHES that file -- it never rewrites its bytes -- and the R5 cycle
// manifest is a SEPARATE object (data/cycles/<build_id>/manifest.json), NEVER nested
// inside shards_manifest.json (that would be a circular dependency).
export const REQUIRED_SINGLETONS = Object.freeze(['id-index.bin', 'hot-shard.bin', 'vector-core.bin', 'meta-knowledge.db', 'meta-report.db', 'shards_manifest.json']);

// CANONICAL rankings authority = src/constants/rankings-groups.js (RANKINGS_DB_NAMES,
// frozen-derived from RANKINGS_GROUPS; RANKINGS_DB_COUNT is "the EXACT expected
// rankings DB count (10). Never a floor, never a minimum"). NO divergent local list.
//
// The OBSOLETE four-type conditional census (RANKING_TYPES x type_counts>0) is REMOVED:
// it derived the required set from type_counts, so a cycle could publish
// partitions.rankings_dbs === true while enumerating FEWER than the exact 10 DBs and
// still be "verified". Current main's pack-finalizer sets that flag ONLY as the RESULT
// of assertRankingsDbSet(), a complete exact-10 verification -- so rankings_dbs === true
// now MEANS all 10, and the census demands all 10 UNCONDITIONALLY (never conditioned on
// type_counts).
const RANKINGS_DB_RE = /^rankings-[a-z0-9-]+\.db$/;
const CANONICAL_RANKINGS = Object.freeze(new Set(RANKINGS_DB_NAMES));
export function requiredRankingsDbs(partitions) {
    if (!partitions || partitions.rankings_dbs !== true) return [];
    return [...RANKINGS_DB_NAMES];
}

export function metaShardLogicals(metaShards) {
    const n = Number(metaShards);
    if (!Number.isInteger(n) || n <= 0) throw new R5StagingError('R5_CENSUS_BAD_PARTITIONS', `meta_shards must be a positive integer, got ${metaShards}`);
    const out = [];
    for (let i = 0; i < n; i += 1) out.push(`meta-${String(i).padStart(2, '0')}.db`);
    return out;
}

/**
 * MANIFEST CENSUS INVARIANT (review G2): the cycle manifest must ENUMERATE the
 * complete expected served set BEFORE any hashing. Re-hash alone cannot catch a
 * logical shard that was silently DROPPED from the manifest — only a census can.
 * Expected = { meta-00.db .. meta-(meta_shards-1).db } UNION REQUIRED_SINGLETONS
 * UNION the EXACT canonical 10 rankings DBs when partitions.rankings_dbs === true,
 * plus the fused-shard contract. Any missing enumeration => fail-closed (never
 * "verified"). Producer-discovered cluster-ann/term_index members carry NO invented
 * completeness rule (no current producer authority fixes their count); whatever the
 * manifest lists is hashed + verified exhaustively by verifyCycleExhaustive below.
 */
export function assertManifestCensus(cycleManifest) {
    const blobs = cycleManifest && cycleManifest.blobs;
    if (!blobs || typeof blobs !== 'object') return { ok: false, failures: ['CENSUS_NO_BLOBS'] };
    const keys = new Set(Object.keys(blobs));
    const failures = [];
    const partitions = cycleManifest.partitions;
    const meta = partitions ? partitions.meta_shards : undefined;
    for (const logical of metaShardLogicals(meta)) if (!keys.has(logical)) failures.push(`CENSUS_MISSING:${logical}`);
    for (const logical of REQUIRED_SINGLETONS) if (!keys.has(logical)) failures.push(`CENSUS_MISSING:${logical}`);
    // EXACT-10 rankings census (never a floor, never type_counts-conditioned).
    const rankingsRequired = requiredRankingsDbs(partitions);
    if (rankingsRequired.length && rankingsRequired.length !== RANKINGS_DB_COUNT) {
        failures.push(`CENSUS_RANKINGS_AUTHORITY_DRIFT:${rankingsRequired.length}!=${RANKINGS_DB_COUNT}`);
    }
    for (const logical of rankingsRequired) if (!keys.has(logical)) failures.push(`CENSUS_MISSING:${logical}`);
    // Fail closed on rankings-DB IDENTITY defects the "missing" pass cannot see: a
    // foreign/unknown rankings-*.db (not one of the canonical 10), and any rankings DB
    // enumerated by a cycle that did NOT declare a verified rankings publication.
    for (const k of keys) {
        if (!RANKINGS_DB_RE.test(k)) continue;
        if (!CANONICAL_RANKINGS.has(k)) failures.push(`CENSUS_RANKINGS_FOREIGN:${k}`);
        else if (rankingsRequired.length === 0) failures.push(`CENSUS_RANKINGS_UNDECLARED:${k}`);
    }
    // FUSED-SET CONTRACT. Producer authority: pack-db.js:97 calls shardWriter.open()
    // UNCONDITIONALLY before the entity loop and :171 finalize() closes it, and
    // ShardWriter.open() (lib/shard-writer.js) creates the file + writes its header
    // immediately -- so EVERY real cycle has at least fused-shard-000.bin. Zero fused
    // shards is therefore NOT a valid cycle: require the FIRST shard so a COMPLETE
    // fused-set omission fails closed, not only an interior gap.
    const fused = [...keys].filter((k) => /^fused-shard-\d+\.bin$/.test(k)).map((k) => Number(k.match(/(\d+)/)[1])).sort((a, b) => a - b);
    if (!keys.has('fused-shard-000.bin')) failures.push('CENSUS_FUSED_SET_ABSENT');
    if (fused.length) {
        for (let i = 1; i <= fused[fused.length - 1]; i += 1) {
            if (!keys.has(`fused-shard-${String(i).padStart(3, '0')}.bin`)) failures.push(`CENSUS_FUSED_GAP:${i}`);
        }
    }
    return { ok: failures.length === 0, failures };
}

/**
 * Exhaustive GET-and-rehash of EVERY blob (never key/HEAD trust). Any missing /
 * hash-mismatch / 412 / 5xx / download-failure => cycle NOT verified (fail-closed).
 * On a key-vs-bytes mismatch (POISON): fail-closed + a write-once quarantine record;
 * NEVER overwrite a write-once key (recover only via a new build_id). downloadBlob(key)
 * -> Buffer (throws on absent/5xx); putQuarantine(key, body) -> create-only writer.
 * Both injected (DI). FENCED: no-op unless mode:'stage_enabled' is passed.
 */
export async function verifyCycleExhaustive({ mode = STAGE_MODE, cycleManifest, downloadBlob, putQuarantine, log = () => {} }) {
    if (!stagingEnabled(mode)) {
        log('[R5-VERIFY] stage_disabled — fenced no-op (no GET-and-rehash, no quarantine)');
        return { ok: false, verified: false, fenced: true, failures: [] };
    }
    const census = assertManifestCensus(cycleManifest);
    if (!census.ok) return { ok: false, verified: false, fenced: false, failures: census.failures };
    const buildId = cycleManifest.build_id;
    const failures = [];
    for (const [logical, sha] of Object.entries(cycleManifest.blobs)) {
        let bytes;
        try { bytes = await downloadBlob(`data/blobs/${sha}`); }
        catch (e) { failures.push(`DOWNLOAD_FAIL:${logical}:${(e && (e.code || e.message)) || 'err'}`); continue; }
        if (!bytes) { failures.push(`ABSENT:${logical}`); continue; }
        const actual = sha256(bytes);
        if (actual === sha) continue;
        failures.push(`POISON:${logical}:${actual}!=${sha}`);
        if (putQuarantine) {
            const rec = JSON.stringify({ expected_sha: sha, actual_sha: actual, key: `data/blobs/${sha}`, logical, build_id: buildId, run_id: process.env.GITHUB_RUN_ID || null, run_attempt: process.env.GITHUB_RUN_ATTEMPT || null });
            try { await putQuarantine(`data/quarantine/${buildId}/${sha}.json`, Buffer.from(rec)); }
            catch { failures.push(`QUARANTINE_WRITE_FAIL:${sha}`); }
        }
    }
    const ok = failures.length === 0;
    return { ok, verified: ok, fenced: false, failures };
}

// Fenced workflow VERIFY entrypoint — a no-op in production (stage_disabled).
export async function main() {
    if (!stagingEnabled()) {
        console.log('[R5-VERIFY] stage_disabled — fenced no-op. No GET-and-rehash, no R2 mutation, no data/current.json. (Activation = a future separate Founder ruling.)');
        return;
    }
    throw new Error('[R5-VERIFY] staging enabled but no production activation wiring exists (fenced by design).');
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) main().catch((err) => { console.error('❌ R5-VERIFY fatal:', err); process.exit(1); });
