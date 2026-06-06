/**
 * Bake silent-zero canaries (extracted from verify-db.js to stay under CES 250).
 *
 * Context: CI never runs the packer (#2137/#2144), so verify-db.js is the bake's
 * ONLY defense against a producer silently emitting zeros/empties. These three
 * canaries close the coverage gaps the 2026-06-06 backend audit flagged:
 *   1. per-edge-type topology (aggregate topo>0 masks a whole relation CLASS),
 *   2. high-value hot columns going total-null (presence-only check missed it),
 *   3. bake-only binary producers shipping empty/corrupt (CDN-warmed unchecked).
 *
 * Every threshold below is deliberately CONSERVATIVE: a false canary blocks every
 * bake, so each asserts only that a thing is NON-TRIVIAL, never a high ratio.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

/**
 * 1. Per-edge-type topology canary.
 *
 * verify-db's aggregate `topo > 0` passes on a SINGLE BASED_ON edge even if
 * CITES / TRAINED_ON / USES were all silently stripped by a projection bug
 * (exactly how EVALUATED_ON silent-zeroed invisibly until #2144). We assert each
 * CRITICAL relation class is independently present.
 *
 * CRITICAL set = the four classes that are structurally guaranteed at corpus
 * scale (every cycle has model->dataset TRAINED_ON, paper CITES, model BASED_ON,
 * tool/ecosystem USES). EVALUATED_ON keeps its own dedicated check in verify-db.
 * Rare/optional classes (IMPLEMENTS, DEMO_OF, DEP) are intentionally EXCLUDED:
 * they can legitimately be 0 in a cycle, so asserting them > 0 would false-fire.
 */
const CRITICAL_EDGE_TYPES = ['BASED_ON', 'TRAINED_ON', 'CITES', 'USES'];
const TOPOLOGY = new Set(['BASED_ON', 'TRAINED_ON', 'CITES', 'USES', 'IMPLEMENTS', 'DEMO_OF', 'DEP', 'EVALUATED_ON']);

function verifyEdgeTypeTopology(graph, check) {
    const counts = Object.create(null);
    for (const list of Object.values(graph.edges || {})) {
        for (const e of (Array.isArray(list) ? list : [])) {
            const t = ((Array.isArray(e) ? e[1] : (e.type || e.relation_type)) || '').toUpperCase();
            if (!t) continue;
            counts[t] = (counts[t] || 0) + 1;
        }
    }
    for (const t of CRITICAL_EDGE_TYPES) {
        const n = counts[t] || 0;
        // Floor is > 0 (not a ratio): at real corpus scale each class numbers in
        // the thousands, so 0 unambiguously means the whole class was stripped.
        check(`Edge: ${t}`, n > 0, `${n} edges (need > 0)`);
    }
}

/**
 * V27.94 (A.3) mesh relation-content canary + per-edge-type extension (#audit
 * 2026-06-06): aggregate topology + EVALUATED_ON + each critical class > 0, plus
 * a degeneracy check over top-FNI ui_related_mesh. Moved here from verify-db.js
 * (CES 250) — `database`/`check` are passed in rather than module-scoped.
 */
export function verifyRelationContent(database, hasMeshGraph, check) {
    if (hasMeshGraph) {
        try {
            const graph = JSON.parse(database.prepare("SELECT value FROM site_metadata WHERE key='mesh_graph'").get().value);
            let topo = 0, total = 0, evalOn = 0;
            for (const list of Object.values(graph.edges || {})) {
                for (const e of (Array.isArray(list) ? list : [])) {
                    total++;
                    const t = ((Array.isArray(e) ? e[1] : (e.type || e.relation_type)) || '').toUpperCase();
                    if (TOPOLOGY.has(t)) topo++; if (t === 'EVALUATED_ON') evalOn++; // EVALUATED_ON dedicated count
                }
            }
            check('Mesh Topology Edges', topo > 0, `${topo} topology / ${total} total (need > 0)`);
            check('EVALUATED_ON edges', evalOn > 0, `${evalOn} model-benchmark (need > 0)`);
            verifyEdgeTypeTopology(graph, check); // per-class: catch a whole relation type silent-zeroing
        } catch (e) {
            check('Mesh Topology Edges', false, `mesh_graph parse failed: ${e.message.slice(0, 40)}`);
        }
    }
    // Degeneracy: sample top-FNI rows; degenerate = unresolved (no id / name===id / _unresolved).
    try {
        const rows = database.prepare("SELECT ui_related_mesh AS m FROM entities WHERE ui_related_mesh IS NOT NULL AND ui_related_mesh != '[]' ORDER BY fni_score DESC LIMIT 500").all();
        let relCount = 0, degen = 0;
        for (const r of rows) {
            let arr; try { arr = JSON.parse(r.m); } catch { continue; }
            for (const rel of (Array.isArray(arr) ? arr : [])) {
                relCount++;
                if (rel?._unresolved || !rel?.id || rel.name == null || rel.name === rel.id) degen++;
            }
        }
        if (relCount < 50) { console.log(`[VERIFY] Mesh Degeneracy: skipped (${relCount} sampled < 50 floor)`); return; }
        const ratio = degen / relCount;
        check('Mesh Degeneracy', ratio <= 0.20, `${(ratio * 100).toFixed(1)}% degenerate of ${relCount} (limit: 20%)`);
    } catch (e) {
        console.log(`[VERIFY] Mesh Degeneracy: skipped (${e.message.slice(0, 40)})`);
    }
}

/**
 * 2. Value-canary for high-value hot columns.
 *
 * verify-db checks column PRESENCE only — a column can exist yet be 100% NULL
 * (e.g. PR-3 deep columns silent-zeroing, or gh `stars` projection dropping).
 * We sample the top-1000-by-FNI rows (the rows users actually see) across ALL
 * meta shards and assert each representative column has at least ONE non-null,
 * non-zero value.
 *
 * Threshold rationale: `> 0 populated`, NOT a ratio. These columns are
 * legitimately SPARSE — `stars` only applies to GitHub entities, `num_heads`/
 * `sdk` only to models with deep specs — so a high ratio would false-fire on a
 * healthy-but-sparse corpus. But a TOTAL-null regression (the actual failure
 * mode) drives the populated count to exactly 0, which this catches loud.
 */
const VALUE_CANARY_COLS = ['stars', 'num_heads', 'sdk'];
const VALUE_SAMPLE_SIZE = 1000;

export function verifyHotColumnValues(dirPath, check) {
    const shardFiles = fs.readdirSync(dirPath)
        .filter(f => /^meta-\d+\.db$/.test(f))
        .map(f => path.join(dirPath, f));
    if (shardFiles.length === 0) return; // not a hash-sharded layout; nothing to do
    const populated = Object.fromEntries(VALUE_CANARY_COLS.map(c => [c, 0]));
    let sampled = 0;
    // Merge each shard's local top-FNI slice; the union over-covers the global
    // top-1000 (a hot row lives in exactly one shard), so a populated value
    // anywhere in any shard's hot slice counts — only an all-shard total-null
    // collapse yields 0.
    for (const fp of shardFiles) {
        const db = new Database(fp, { readonly: true });
        try {
            const cols = db.prepare("PRAGMA table_info(entities)").all().map(c => c.name);
            const present = VALUE_CANARY_COLS.filter(c => cols.includes(c));
            if (present.length === 0) { db.close(); continue; }
            const sel = present.join(', ');
            const rows = db.prepare(
                `SELECT ${sel} FROM entities ORDER BY fni_score DESC LIMIT ${VALUE_SAMPLE_SIZE}`
            ).all();
            for (const r of rows) {
                sampled++;
                for (const c of present) {
                    const v = r[c];
                    if (v !== null && v !== undefined && v !== '' && v !== 0) populated[c]++;
                }
            }
        } finally { db.close(); }
    }
    if (sampled === 0) { console.log('[VERIFY] Value canary: skipped (0 rows sampled)'); return; }
    for (const c of VALUE_CANARY_COLS) {
        check(`Value: ${c}`, populated[c] > 0, `${populated[c]} populated of ${sampled} sampled`);
    }
}

/**
 * 3. Bake-only producer floor checks.
 *
 * The bake writes binary artifacts that the deploy CDN-warms with NO post-build
 * verification — any can ship empty/corrupt invisibly. We assert a magic-byte
 * header + a record-count / size floor for each, mirroring verify-db's NXVF
 * pattern. Where an artifact is legitimately skippable, the check is conditional
 * (assert only IF the producer should have run).
 *
 * Floors are intentionally tiny (existence + non-empty + sane magic), NOT scaled
 * to corpus size — they catch the catastrophic "wrote 0 records / wrong format /
 * truncated" failure, without false-firing if the corpus is small or a producer
 * legitimately skipped.
 */
// cluster-ann skips when vectors < NUM_CLUSTERS*10 = 1280 (cluster-ann-builder.js).
const CLUSTER_ANN_SKIP_FLOOR = 1280;

function magicOk(buf, ascii) {
    return buf.length >= ascii.length && buf.toString('ascii', 0, ascii.length) === ascii;
}

export function verifyBakeProducers(dataDir, check) {
    // --- vector-core.bin: magic VECT, count @6 (UInt32). Skipped only if 0 top entities. ---
    binMagicCount(check, path.join(dataDir, 'vector-core.bin'), 'VECT', 6, 'vector-core.bin');
    // --- hot-shard.bin: magic HOTS, count @6 (UInt32). ---
    binMagicCount(check, path.join(dataDir, 'hot-shard.bin'), 'HOTS', 6, 'hot-shard.bin');
    // --- id-index.bin: magic IDIX, recordCount @12 (UInt32). Skipped only if 0 entities. ---
    binMagicCount(check, path.join(dataDir, 'id-index.bin'), 'IDIX', 12, 'id-index.bin');

    // --- cluster-ann-index.bin: magic CANN, totalVectors @10. CONDITIONAL: the
    // producer skips when < 1280 vectors, so only assert the file when it exists.
    const cannPath = path.join(dataDir, 'cluster-ann-index.bin');
    if (fs.existsSync(cannPath)) {
        const buf = fs.readFileSync(cannPath);
        const ok = magicOk(buf, 'CANN') && buf.length >= 14 && buf.readUInt32LE(10) >= CLUSTER_ANN_SKIP_FLOOR;
        const vecs = magicOk(buf, 'CANN') && buf.length >= 14 ? buf.readUInt32LE(10) : 0;
        check('Producer: cluster-ann', ok, `magic=${magicOk(buf, 'CANN')} vectors=${vecs}`);
    } else {
        console.log('[VERIFY] Producer cluster-ann: skipped (no file — legit if < 1280 vectors)');
    }

    // --- term_index/ (inverted index): manifest is zstd (magic 28 B5 2F FD) + a
    // non-trivial count of prefix-bucket files. Floor: manifest present + zstd
    // magic + >= 2 bucket dirs (a real corpus produces dozens of 2-char prefixes;
    // 0-1 means the build wrote nothing / crashed early). ---
    const manifest = path.join(dataDir, 'term_index', '_manifest.json.zst');
    if (fs.existsSync(manifest)) {
        const m = fs.readFileSync(manifest);
        const zstdMagic = m.length >= 4 && m[0] === 0x28 && m[1] === 0xB5 && m[2] === 0x2F && m[3] === 0xFD;
        const buckets = fs.readdirSync(path.join(dataDir, 'term_index'))
            .filter(f => f !== '_manifest.json.zst').length;
        check('Producer: term_index', zstdMagic && buckets >= 2, `zstd=${zstdMagic} entries=${buckets} (need >= 2)`);
    } else {
        check('Producer: term_index', false, 'term_index/_manifest.json.zst missing');
    }

    // --- parquet: entities-*.parquet, magic PAR1 at head AND tail (the Parquet
    // footer marker). A truncated/empty writer fails the tail check. ---
    const parquetDir = path.join(dataDir, '..', 'parquet');
    if (fs.existsSync(parquetDir)) {
        const files = fs.readdirSync(parquetDir).filter(f => f.endsWith('.parquet'));
        if (files.length > 0) {
            const fp = path.join(parquetDir, files.sort().reverse()[0]); // newest epoch
            const buf = fs.readFileSync(fp);
            const head = magicOk(buf, 'PAR1');
            const tail = buf.length >= 4 && buf.toString('ascii', buf.length - 4) === 'PAR1';
            // > 8 bytes rules out an empty header+footer-only file (no row groups).
            check('Producer: parquet', head && tail && buf.length > 12, `head=${head} tail=${tail} size=${buf.length}`);
        } else {
            check('Producer: parquet', false, 'no .parquet file in output/parquet');
        }
    } else {
        console.log('[VERIFY] Producer parquet: skipped (no output/parquet dir)');
    }
}

/** Assert a fixed-magic binary exists, matches magic, and has count@offset > 0. */
function binMagicCount(check, fp, magic, countOffset, label) {
    if (!fs.existsSync(fp)) { check(`Producer: ${label}`, false, 'file missing'); return; }
    const buf = fs.readFileSync(fp);
    const okMagic = magicOk(buf, magic);
    const count = okMagic && buf.length >= countOffset + 4 ? buf.readUInt32LE(countOffset) : 0;
    // Floor is count > 0: empty/zero-record output is the silent-zero we guard.
    check(`Producer: ${label}`, okMagic && count > 0, `magic=${okMagic} count=${count}`);
}
