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

// Always-present served singletons every cycle manifest MUST enumerate. id-index/
// hot-shard/vector-core ship in the R2 serving prefix; meta-knowledge.db (knowledge
// .astro + concepts.ts) and meta-report.db (trends.astro) are built unconditionally
// by meta-anchors.js (even empty), so they are unconditional here too.
export const REQUIRED_SINGLETONS = Object.freeze(['id-index.bin', 'hot-shard.bin', 'vector-core.bin', 'meta-knowledge.db', 'meta-report.db']);

// Reader-served rankings entity types (catalog-fetcher rankings-<type>.db +
// select.ts rankings-model.db). Mirrors ENTITY_TYPES in rankings-generator.js.
export const RANKING_TYPES = Object.freeze(['model', 'paper', 'dataset', 'tool']);

// CONDITIONAL: rankings-<type>.db is present only when the cycle emitted rankings
// dbs (partitions.rankings_dbs) AND that type is non-empty (type_counts[type] > 0),
// exactly the reader contract. Derived from the manifest so the census FAILS-CLOSED
// on a dropped should-be-present rankings db WITHOUT over-failing a valid cycle that
// legitimately lacks rankings (rankings_dbs !== true) or an empty type.
export function requiredRankingsDbs(partitions) {
    if (!partitions || partitions.rankings_dbs !== true) return [];
    const tc = partitions.type_counts;
    if (!tc || typeof tc !== 'object') return [];
    return RANKING_TYPES.filter((t) => Number(tc[t]) > 0).map((t) => `rankings-${t}.db`);
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
 * UNION the conditional rankings dbs derived from partitions (requiredRankingsDbs),
 * plus fused-shard-*.bin contiguity (0..max, no gap) over whatever fused blobs are
 * listed. Any missing enumeration => fail-closed (never "verified").
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
    for (const logical of requiredRankingsDbs(partitions)) if (!keys.has(logical)) failures.push(`CENSUS_MISSING:${logical}`);
    const fused = [...keys].filter((k) => /^fused-shard-\d+\.bin$/.test(k)).map((k) => Number(k.match(/(\d+)/)[1])).sort((a, b) => a - b);
    if (fused.length) {
        for (let i = 0; i <= fused[fused.length - 1]; i += 1) {
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
