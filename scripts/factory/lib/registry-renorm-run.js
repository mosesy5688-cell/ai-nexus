/**
 * OP-GR-B orchestration (ruling D-2026-0810-418). Dependency-injected so every
 * terminal path -- inert, marker-skip, self-abandon, verified -- is reachable
 * from a test with synthetic NXVF fixtures and a fake R2, never the real ones.
 *
 * FAIL-CLOSED ORDER, in the order the ruling states it:
 *   1. flag off              -> INERT (nothing read, nothing written)
 *   2. marker present        -> SKIPPED (one-time insurance (a))
 *   3. marker unreadable     -> ABANDONED (never assume "not yet run")
 *   4. no key / no shards    -> ABANDONED
 *   5. scan + DRY-RUN MANIFEST written BEFORE any mutation
 *   6. cohort mismatch       -> ABANDONED, zero rewrites, cascade unaffected
 *   7. PRE-IMAGE SNAPSHOT (hashed both sides) BEFORE any mutation
 *   8. stage every rewrite to temp; swap only after ALL succeed
 *   9. verify; only then write the completion marker
 *
 * This module never calls process.exit and never prints record content.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { readMarker, writeMarker, fetchMarkerBody, MARKER } from './registry-renorm-marker.js';
import { initCrypto, readShardIndex, entityIsGiant, entityText, rewriteShard, entityCountOf } from './registry-renorm-shard.js';
import { loadCensus, transformRecord, reconcile, accounting, verifyOutcome, GIANT_MIN_BYTES, RECONCILE } from './registry-renorm-core.js';

export const OUTCOME = Object.freeze({
    INERT: 'INERT',
    SKIPPED_MARKER_PRESENT: 'SKIPPED_MARKER_PRESENT',
    ABANDONED: 'ABANDONED',
    VERIFIED: 'VERIFIED',
    VERIFICATION_FAILED: 'VERIFICATION_FAILED',
});

/**
 * EXIT-CODE POLICY, as a predicate so it can be tested exhaustively rather than
 * inferred from a ternary buried in the CLI.
 *
 * VERIFICATION_FAILED is the ONLY non-zero terminal: the registry WAS mutated
 * and did not verify, so the cascade must stop loudly. Every other terminal --
 * INERT, SKIPPED_MARKER_PRESENT, ABANDONED, VERIFIED -- performed zero
 * mutations or a verified one, so the cascade must proceed exactly as today.
 */
export function exitCodeFor(outcome) {
    return outcome === OUTCOME.VERIFICATION_FAILED ? 1 : 0;
}

/**
 * WHICH REGISTRY COPIES THIS CYCLE REFRESHES. 1/4 can only OBSERVE its own
 * local write; everything downstream is an EXPECTATION carrying the exact stage
 * and step that will perform it. Never claim a later stage's write as done.
 */
export const REFRESH_CENSUS = Object.freeze([
    { copy: 'cache/registry/*.bin (runner-local working registry)', stage: '1/4 harvest', step: 'this step; rewritten again by Merge Batches -> RegistryManager.save()', observable_here: true },
    { copy: 'R2 state/cycle-harvest/cache/registry/', stage: '1/4 harvest', step: 'Backup Harvest Data to R2 (backup-dir cache/ state/cycle-harvest/cache/)', observable_here: false },
    { copy: 'GHA cache global-registry-<run_id> (THE carrier the next cycle restores from)', stage: '3/4 aggregate', step: 'actions/cache/save@v5 (path cache/registry/)', observable_here: false },
    { copy: 'R2 state/registry/', stage: '3/4 aggregate', step: 'backup-dir cache/registry/ state/registry/', observable_here: false },
    { copy: 'R2 meta/backup/registry/', stage: '3/4 aggregate + 4/4 upload', step: 'saveRegistryShard PutObject under ENABLE_R2_BACKUP=true', observable_here: false },
]);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n'); };

/** Scan the working registry for records at or above the producer bound. */
async function scanRegistry(registryDir, shardFiles, log) {
    const rows = [], perShard = new Map();
    const probes = { 'frame-header': 0, 'block-bound': 0, decompressed: 0 };
    let entitiesSeen = 0;
    for (const file of shardFiles) {
        const shard = readShardIndex(path.join(registryDir, file));
        if (!shard.checksumOk) return { fatal: `offset-table checksum mismatch in ${file}` };
        entitiesSeen += shard.header.entityCount;
        for (const entry of shard.entries) {
            const probe = await entityIsGiant(shard, entry, GIANT_MIN_BYTES);
            probes[probe.probed] = (probes[probe.probed] || 0) + 1;
            if (!probe.giant) continue;
            const text = (await entityText(shard, entry)).toString('utf8');
            const { governed, row, afterText } = transformRecord(text);
            row.shard = file;
            row.entity_index = entry.index;
            rows.push(row);
            if (governed) {
                if (!perShard.has(file)) perShard.set(file, new Map());
                perShard.get(file).set(entry.index, Buffer.from(afterText, 'utf8'));
            }
        }
        log(`scanned ${file} (${shard.header.entityCount} entities, ${rows.length} giant(s) so far)`);
    }
    return { rows, perShard, entitiesSeen, probes };
}

/** Copy every affected shard to the pre-image dir, hashing source and copy. */
function snapshot(registryDir, preDir, files, maxBytes) {
    fs.mkdirSync(preDir, { recursive: true });
    const entries = [];
    let total = 0;
    for (const file of files) {
        const buf = fs.readFileSync(path.join(registryDir, file));
        total += buf.length;
        if (total > maxBytes) {
            return { fatal: `pre-image snapshot would exceed ${maxBytes} B (at ${total} B over ${entries.length + 1} shard(s))` };
        }
        const dst = path.join(preDir, file);
        fs.writeFileSync(dst, buf);
        const digest = sha256(buf);
        if (digest !== sha256(fs.readFileSync(dst))) return { fatal: `pre-image verification failed for ${file}` };
        entries.push({ shard: file, bytes: buf.length, sha256: digest, verified: true });
    }
    return { entries, total };
}

/**
 * Execute the re-normalisation. Returns a result object; the caller maps it to
 * an exit code. `deps.s3` may be any object exposing send() -- tests pass a fake.
 */
export async function runRenorm(deps) {
    const {
        s3, bucket, censusDoc, registryDir, artifactDir,
        flagEnabled, snapshotMaxBytes, context = {},
        log = () => { }, loud = () => { },
    } = deps;

    const manifestPath = path.join(artifactDir, 'dry-run-manifest.json');
    const meta = () => ({
        ...context, generated_at_utc: new Date().toISOString(),
        giant_min_bytes: GIANT_MIN_BYTES,
        census_count: censusDoc?.count ?? null,
        forensics_sha256: censusDoc?.forensics_sha256 ?? null,
    });
    const abandon = (reason, detail = {}) => {
        loud(`SELF-ABANDON: ${reason}`);
        loud('ZERO records were rewritten. The cascade proceeds unchanged.');
        // PR-GR-C (D-2026-0812-421): PRESERVE the dry-run evidence. This used to
        // overwrite the manifest at the same path, destroying records[],
        // accounting, size_probes and affected_shards exactly in the case where
        // they matter most -- the run 31563250233 investigation had to rebuild
        // that evidence from R2 because the abandon had erased it. Merge onto
        // whatever was already written instead; an abandon that fires BEFORE the
        // full manifest exists (no credentials, unreadable marker, no key, no
        // shards, bad census) simply has nothing to merge and writes the short
        // form, exactly as before. Same path, so the artifact upload is unchanged.
        let prior = {};
        try { prior = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* nothing written yet */ }
        writeJson(manifestPath, { ...prior, status: OUTCOME.ABANDONED, reason, ...meta(), ...detail });
        return { outcome: OUTCOME.ABANDONED, reason, records: Array.isArray(prior.records) ? prior.records.length : 0 };
    };

    if (!flagEnabled) {
        log('flag is not "true" -- step is inert. Nothing read, nothing written.');
        return { outcome: OUTCOME.INERT };
    }
    fs.mkdirSync(artifactDir, { recursive: true });

    if (!s3) return abandon('no R2 credentials -- cannot read the one-time completion marker');

    const marker = await readMarker(s3, bucket);
    if (marker.state === MARKER.PRESENT) {
        const body = await fetchMarkerBody(s3, bucket);
        log(`completion marker present (run ${body?.run_id || 'unknown'}) -- already done, skipping.`);
        writeJson(manifestPath, { status: OUTCOME.SKIPPED_MARKER_PRESENT, marker: body, ...meta() });
        return { outcome: OUTCOME.SKIPPED_MARKER_PRESENT, marker: body };
    }
    if (marker.state === MARKER.UNKNOWN) {
        return abandon(`completion marker unreadable (${marker.error}) -- refusing to run a one-time operation without confirming it has not already run`);
    }

    if (!initCrypto()) return abandon('AES_CRYPTO_KEY absent or too short -- NXVF payloads cannot be decrypted');

    let census;
    try { census = loadCensus(censusDoc); } catch (e) { return abandon(e.message); }

    const shardFiles = fs.existsSync(registryDir)
        ? fs.readdirSync(registryDir).filter((f) => /^part-\d+\.bin$/.test(f)).sort() : [];
    if (shardFiles.length === 0) return abandon(`no NXVF shards found in ${registryDir}`);
    log(`working registry: ${shardFiles.length} shard(s); census: ${census.count} id(s); giant bound: ${GIANT_MIN_BYTES} B`);

    const scan = await scanRegistry(registryDir, shardFiles, log);
    if (scan.fatal) return abandon(scan.fatal);

    const rec = reconcile(scan.rows, census);
    writeJson(manifestPath, {
        status: rec.status, ...meta(),
        shards_scanned: shardFiles.length, entities_scanned: scan.entitiesSeen,
        size_probes: scan.probes, reconciliation: rec, accounting: accounting(scan.rows),
        affected_shards: [...scan.perShard.keys()].sort(), records: scan.rows,
    });

    if (rec.status !== RECONCILE.MATCH) {
        loud(`DRY-RUN MISMATCH -- expected ${rec.expected} census id(s), observed ${rec.observed} giant(s).`);
        for (const r of rec.reasons) loud(`  reason: ${r}`);
        for (const id of rec.missing.slice(0, 20)) loud(`  missing: ${id}`);
        for (const id of rec.extra.slice(0, 20)) loud(`  extra:   ${id}`);
        for (const u of rec.ungoverned.slice(0, 20)) loud(`  ungoverned: ${u.id} touched ${u.fields_changed.join(',')}`);
        return abandon('cohort does not match the forensics census one for one', { reconciliation: rec });
    }
    log(`DRY-RUN MATCH: ${rec.observed}/${rec.expected} census id(s); only governed fields change.`);

    const affected = [...scan.perShard.keys()].sort();
    const preDir = path.join(artifactDir, 'pre-image');
    const pre = snapshot(registryDir, preDir, affected, snapshotMaxBytes);
    if (pre.fatal) return abandon(pre.fatal, { affected_shards: affected.length });
    writeJson(path.join(preDir, 'SHA256SUMS.json'), { ...meta(), total_bytes: pre.total, shards: pre.entries });
    log(`pre-image snapshot: ${pre.entries.length} shard(s), ${pre.total} B, all SHA-256 verified`);

    const tmpDir = path.join(artifactDir, 'staged');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    const staged = [];
    for (const file of affected) {
        const r = await rewriteShard(path.join(registryDir, file), tmpDir, scan.perShard.get(file));
        staged.push({ shard: file, ...r });
        log(`staged ${file}: ${r.replaced} record(s) rewritten, ${r.entityCount} entities preserved`);
    }
    for (const s of staged) fs.renameSync(s.outPath, path.join(registryDir, s.shard));
    log(`swapped ${staged.length} shard(s) into ${registryDir}`);

    const shardStats = staged.map((s) => ({
        shard: s.shard, entity_count_before: s.entityCount, replaced: s.replaced,
        entity_count_after: entityCountOf(path.join(registryDir, s.shard)),
        file_bytes_before: s.fileBytesBefore, file_bytes_after: s.fileBytesAfter,
    }));
    const verification = verifyOutcome({ rows: scan.rows, shards: shardStats });
    writeJson(path.join(artifactDir, 'verification.json'), {
        status: verification.ok ? OUTCOME.VERIFIED : OUTCOME.VERIFICATION_FAILED, ...meta(),
        verification, shards: shardStats, pre_image: pre.entries,
        accounting: accounting(scan.rows), refresh_census: REFRESH_CENSUS,
        transitional_obligation: 'The R2 registry copies are refreshed by LATER stages, not by 1/4. Rows with observable_here=false are EXPECTATIONS naming the exact stage and step, not confirmations.',
    });
    if (!verification.ok) {
        loud('POST-TRANSFORM VERIFICATION FAILED -- completion marker NOT written.');
        return { outcome: OUTCOME.VERIFICATION_FAILED, verification };
    }

    const acc = accounting(scan.rows);
    const written = await writeMarker(s3, bucket, {
        ...meta(), shards_rewritten: staged.length, records_rewritten: scan.rows.length,
        bytes_reclaimed: acc.bytes_reclaimed_total,
    });
    log(`completion marker written to ${written.key} (${written.bytes} B). OP-GR-B done.`);
    return { outcome: OUTCOME.VERIFIED, verification, shards: shardStats, accounting: acc, marker: written };
}
