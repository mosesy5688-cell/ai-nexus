/**
 * V26.5 Pack Finalizer - Shard hash, optimization, and post-pack generation
 * V26.5: search.db eliminated.
 * V27.104: fts.db eliminated (no live reader) — only metaDbs remain.
 */
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';

// R5 Phase 2 (cycle-manifest emit) — the served-artifact classes whose whole-object
// sha256 IS the content-address (data/blobs/<sha256>). Enumerated at finalize; note
// the pack ORDER generates id-index/hot-shard/vector-core/cluster-ann/term_index
// AFTER finalizePack, so the finalize-time manifest captures whatever is already on
// disk. This local manifest is NEVER uploaded here (STAGE is a separate, fenced step).
const R5_SERVED_TOPLEVEL = [
    (n) => /^meta-\d+\.db$/.test(n),                                   // dynamic meta shards
    (n) => n === 'meta-knowledge.db' || n === 'meta-report.db',        // reader anchor singletons
    (n) => /^rankings-[a-z0-9-]+\.db$/.test(n),                        // rankings-<group>.db (type/category/all)
    (n) => /^fused-shard-\d+\.bin$/.test(n),
    (n) => n === 'id-index.bin' || n === 'hot-shard.bin' || n === 'vector-core.bin',
    (n) => /^cluster-ann/.test(n),
];
const R5_SERVED_SUBDIRS = new Set(['term_index']);

export function sha256File(absPath) {
    return crypto.createHash('sha256').update(fsSync.readFileSync(absPath)).digest('hex');
}

/** Discover every served artifact currently on disk under shardDir (recurses
 *  term_index/ + cluster-ann dirs). Logical name = forward-slash path from shardDir. */
export function discoverServedArtifacts(shardDir) {
    const out = [];
    for (const entry of fsSync.readdirSync(shardDir, { withFileTypes: true })) {
        const n = entry.name;
        if (entry.isFile() && R5_SERVED_TOPLEVEL.some((f) => f(n))) {
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

/** Emit the local cycle manifest under <shardDir>/cycles/<buildId>/manifest.json
 *  (mirrors the R2 data/cycles/ layout). LOCAL ONLY — no R2 write; the legacy
 *  uploader EXCLUDES data/cycles/ so this file is never PUT in production. */
export async function emitCycleManifest(shardDir, buildId, partitions) {
    const artifacts = discoverServedArtifacts(shardDir);
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
    try { if (fsSync.readdirSync(shardDir).some(f => f.startsWith('rankings-') && f.endsWith('.db'))) partitionCounts.rankings_dbs = true; } catch {};
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

    // R5 Phase 2: emit the immutable per-cycle manifest LOCALLY (per-artifact
    // sha256). Additive + separate file — shards_manifest.json above is untouched.
    try {
        await emitCycleManifest(shardDir, buildId, partitionCounts);
    } catch (e) {
        console.warn(`[R5-CYCLE-MANIFEST] emit skipped: ${e.message}`);
    }

    console.log('[VFS] Optimizing databases...');
    const vacStart = Date.now();
    Object.values(metaDbs).forEach(db => db.exec("VACUUM;"));
    console.log(`[VFS] VACUUM ${Object.keys(metaDbs).length} meta DBs (${((Date.now() - vacStart) / 1000).toFixed(1)}s)`);

    printBuildSummary(metaDbs, null, stats, currentShardId);
}
