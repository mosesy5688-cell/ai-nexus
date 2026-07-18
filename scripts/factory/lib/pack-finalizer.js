/**
 * V26.5 Pack Finalizer - Shard hash, optimization, and post-pack generation
 * V26.5: search.db eliminated.
 * V27.104: fts.db eliminated (no live reader) — only metaDbs remain.
 */
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import { assertRankingsDbSet, verifyOptsFromEnv } from './rankings-db-verifier.js';

// R5 Phase 2 (cycle-manifest SUBSTRATE, not an emitter) — the served-artifact classes
// whose whole-object sha256 IS the content-address (data/blobs/<sha256>). Under Phase 2
// there is NO production cycle manifest at all: finalizePack does NOT emit one, and the
// exported emitCycleManifest helper below has ZERO production callers (it is a local /
// dependency-injection test substrate only). The pack ORDER generates id-index /
// hot-shard / vector-core / cluster-ann / term_index AFTER finalizePack returns, so NO
// point inside finalizePack is a valid end-of-pack integrity barrier — the defect is not
// fixed by relocating an emit within this function. Production emission AND its transport
// require a separate Founder activation ruling that first introduces a true end-of-pack
// barrier (Phase 3); that work is not authorized here.
const R5_SERVED_TOPLEVEL = [
    (n) => /^meta-\d+\.db$/.test(n),                                   // dynamic meta shards
    (n) => n === 'meta-knowledge.db' || n === 'meta-report.db',        // reader anchor singletons
    // D-395: shards_manifest.json is a served singleton (reader shard/partitions
    // authority). HASHED ONLY -- discoverServedArtifacts never writes, and the R5
    // cycle manifest is a SEPARATE file, never nested inside shards_manifest.json.
    (n) => /^shards_manifest\.json$/.test(n),
    (n) => /^fused-shard-\d+\.bin$/.test(n),
    (n) => n === 'id-index.bin' || n === 'hot-shard.bin' || n === 'vector-core.bin',
    (n) => /^cluster-ann/.test(n),
];
const R5_SERVED_SUBDIRS = new Set(['term_index']);

// NOTE: deliberately a loop, NOT Array.prototype.some — the D-395 rankings-authority
// invariant (tests/srs1/rankings-db-seam-b-publication-invariant.test.ts #16) bans the
// invariant #16 bans that token anywhere in this file, so the retired any-one-file rankings
// shortcut can never reappear. This is class matching over served artifacts, not a set check.
function isServedTopLevel(name) {
    for (const match of R5_SERVED_TOPLEVEL) if (match(name)) return true;
    return false;
}

export function sha256File(absPath) {
    return crypto.createHash('sha256').update(fsSync.readFileSync(absPath)).digest('hex');
}

/** Discover every served artifact currently on disk under shardDir (recurses
 *  term_index/ + cluster-ann dirs). Logical name = forward-slash path from shardDir. */
export function discoverServedArtifacts(shardDir, verifiedNames = []) {
    const out = [];
    // verifiedNames = served files enumerated by an EXTERNAL authority rather than by a
    // local pattern (currently the D-395 complete-set verifier's own member list).
    const verified = new Set(verifiedNames);
    for (const entry of fsSync.readdirSync(shardDir, { withFileTypes: true })) {
        const n = entry.name;
        if (entry.isFile() && (isServedTopLevel(n) || verified.has(n))) {
            out.push({ logical: n, absPath: path.join(shardDir, n) });
        } else if (entry.isDirectory() && (R5_SERVED_SUBDIRS.has(n) || /^cluster-ann/.test(n))) {
            const stack = [path.join(shardDir, n)];
            while (stack.length) {
                const d = stack.pop();
                for (const e2 of fsSync.readdirSync(d, { withFileTypes: true })) {
                    const p = path.join(d, e2.name);
                    if (e2.isDirectory()) stack.push(p);
                    else out.push({ logical: path.relative(shardDir, p).replace(/\\/g, '/'), absPath: p });
                }
            }
        }
    }
    out.sort((a, b) => a.logical.localeCompare(b.logical));
    return out;
}

/** Immutable per-cycle manifest { build_id, partitions, blobs:{logical->sha256} }.
 *  The whole-object sha256 doubles as the content-address blob key (key==content
 *  by construction at the producer). */
export function buildCycleManifest({ buildId, partitions, artifacts }) {
    const blobs = {};
    for (const a of artifacts) blobs[a.logical] = sha256File(a.absPath);
    return { build_id: buildId || null, partitions: { ...partitions }, blobs };
}

/** LOCAL / DEPENDENCY-INJECTION TEST SUBSTRATE ONLY — NOT a production emitter.
 *  This helper performs only a local filesystem write of a cycle manifest under
 *  <shardDir>/cycles/<buildId>/manifest.json (mirroring the R2 data/cycles/ layout);
 *  it performs no R2 write and no transport of any kind. Under Phase 2 it has NO
 *  production caller: finalizePack does not call it and nothing else in the repository
 *  does. Neither this helper nor any DI fixture built from it proves that a production
 *  cycle manifest would be COMPLETE — the served set is not final when finalizePack
 *  runs. Any future production emission AND its transport require a separate Founder
 *  activation ruling at a true end-of-pack barrier (Phase 3). */
export async function emitCycleManifest(shardDir, buildId, partitions, verifiedNames = []) {
    const artifacts = discoverServedArtifacts(shardDir, verifiedNames);
    const cycleManifest = buildCycleManifest({ buildId, partitions, artifacts });
    const dir = path.join(shardDir, 'cycles', String(buildId));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(cycleManifest, null, 2));
    console.log(`[R5-CYCLE-MANIFEST] hashed ${artifacts.length} served artifacts -> ${path.join(dir, 'manifest.json')} (build ${buildId})`);
    return cycleManifest;
}

export async function finalizePack(metaDbs, manifest, currentShardId, shardDir, cacheDir, stats, partitionCounts, injectMetadata, printBuildSummary, buildId) {
    console.log('[VFS] Computing shard manifest hashes...');
    const hashStart = Date.now();
    for (let i = 0; i <= currentShardId; i++) {
        const name = `fused-shard-${String(i).padStart(3, '0')}.bin`;
        const file = path.join(shardDir, name);
        if (fsSync.existsSync(file)) {
            manifest[`data/${name}`] = crypto.createHash('sha256').update(fsSync.readFileSync(file)).digest('hex');
        }
    }
    console.log(`[VFS] Manifest hashes computed (${((Date.now() - hashStart) / 1000).toFixed(1)}s)`);

    await injectMetadata(metaDbs, null, cacheDir);
    // FAIL-CLOSED rankings-DB publication gate (D9a). The old line here was an
    // any-one-file boolean shortcut (`readdirSync(...).some(f => f.startsWith('rankings-'))`)
    // wrapped in a swallowing `try {} catch {}`: one stray DB set the flag true and a
    // partial/absent/corrupt set silently OMITTED the key (the live production shape).
    // Now the flag is the RESULT of a COMPLETE-SET verification -- EXACT 10-name set,
    // SQLite magic + quick_check, schema derived from the producer, per-DB provenance,
    // and one identical run/attempt/head identity across all members (bound to the
    // current-cycle handoff manifest when the workflow supplies it). ANY defect THROWS,
    // so pack-db.js fails -> vfs-pack-db fails -> vfs-derived + upload (which `needs:`
    // it) never run -> ZERO public write and the last-good build keeps serving. The flag
    // is written EXPLICITLY boolean true and is NEVER written false (an absent key can
    // never be read as a verified negative).
    assertRankingsDbSet(shardDir, verifyOptsFromEnv());
    partitionCounts.rankings_dbs = true;
    // V27.26: total_entities = authoritative global catalog size, derived from
    // stats.packed (count of entities written across all meta DBs). Surfaces
    // can read this via manifest.partitions.total_entities to render an honest
    // live count instead of fabricated marketing numbers.
    if (stats && typeof stats.packed === 'number' && stats.packed > 0) {
        partitionCounts.total_entities = stats.packed;
    }

    // V27.49: type-count sanity warning — surface entity-type underrepresentation
    // in cron logs. Catches harvester/adapter regressions early (e.g., dataset
    // adapter throwing silently, prompt adapter not yet built, space adapter
    // mis-typing). Threshold 0.1% (vs the planned 1%) tuned to catch real
    // catalog-wide gaps without false-firing on naturally-rare types.
    try {
        const typeCounts = {};
        for (const db of Object.values(metaDbs)) {
            for (const row of db.prepare('SELECT type, COUNT(*) AS n FROM entities GROUP BY type').iterate()) {
                typeCounts[row.type || '?'] = (typeCounts[row.type || '?'] || 0) + row.n;
            }
        }
        const total = Object.values(typeCounts).reduce((a, b) => a + b, 0);
        partitionCounts.type_counts = typeCounts;
        if (total > 0) {
            for (const [t, n] of Object.entries(typeCounts)) {
                const pct = (n / total) * 100;
                const tag = pct < 0.1 ? '⚠️ UNDER-REPRESENTED' : 'ok';
                console.log(`[VFS-TYPES] ${t}: ${n} (${pct.toFixed(2)}%) ${tag}`);
            }
            // Expected types — warn if completely absent (count=0). Knowledge entities
            // are surface routes (30 static .md), not packed in meta-NN.db — exclude.
            // 'prompt' removed (#2141). 'space' (merged into model) + 'agent'
            // (cancelled) removed — both dropped at the pack source.
            const expectedTypes = ['model', 'paper', 'tool', 'dataset'];
            const missing = expectedTypes.filter(t => !typeCounts[t]);
            if (missing.length > 0) {
                console.warn(`[VFS-TYPES] ⚠️ Expected types absent from catalog: ${missing.join(', ')}`);
            }
        }
    } catch (e) {
        console.warn(`[VFS-TYPES] Sanity check skipped: ${e.message}`);
    }

    // B4 coherence token: the SAME build_id stamped into id-index.bin (passed
    // from pack-db.js, captured once per bake). The read path proves absence ONLY
    // when this manifest build_id === the served index build_id (same bake). Top-
    // level so loadManifest can surface it without descending into partitions.
    const fullManifest = { build_id: buildId || null, shards: manifest, partitions: partitionCounts };
    const manifestJson = JSON.stringify(fullManifest, null, 2);
    const manifestBytes = Buffer.byteLength(manifestJson, 'utf8');
    if (manifestBytes > 5 * 1024 * 1024) {
        throw new Error(`[V55.9] Manifest exceeds 5MB limit (${(manifestBytes / 1024 / 1024).toFixed(2)}MB).`);
    }
    await fs.writeFile(path.join(shardDir, 'shards_manifest.json'), manifestJson);
    console.log(`[VFS] Manifest: ${(manifestBytes / 1024).toFixed(1)}KB (limit: 5MB)`);

    // R5 Phase 2 repair (Founder D-352 F-2 clarification): finalizePack emits NO cycle
    // manifest. The production call that used to sit here — wrapped in a warning-only
    // try/catch that swallowed every failure into a log line — has been
    // REMOVED, not relocated. It hashed the meta DBs before the VACUUM below rewrote
    // them, and further served artifacts are produced after finalizePack returns, so no
    // position inside this function could have made it correct. The VACUUM below is an
    // unrelated, pre-existing optimisation step and is NOT the fix for that defect.

    console.log('[VFS] Optimizing databases...');
    const vacStart = Date.now();
    Object.values(metaDbs).forEach(db => db.exec("VACUUM;"));
    console.log(`[VFS] VACUUM ${Object.keys(metaDbs).length} meta DBs (${((Date.now() - vacStart) / 1000).toFixed(1)}s)`);

    printBuildSummary(metaDbs, null, stats, currentShardId);
}
