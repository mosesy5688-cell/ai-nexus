/**
 * Bake silent-zero canaries (extracted from verify-db.js to stay under CES 250).
 *
 * Context: CI never runs the packer (#2137/#2144), so verify-db.js is the bake's
 * ONLY defense against a producer silently emitting zeros/empties. Three canaries
 * close the gaps the 2026-06-06 backend audit flagged: 1. per-edge-type topology
 * (aggregate topo>0 masks a whole relation CLASS), 2. hot columns going total-null
 * (presence-only check missed it), 3. bake-only binary producers shipping
 * empty/corrupt (CDN-warmed unchecked). Every threshold is CONSERVATIVE: a false
 * canary blocks every bake, so each asserts NON-TRIVIAL presence, never a ratio.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// Mesh topology + PR-1 resolution canary lives in its own module (CES 250);
// re-exported so verify-db.js keeps importing it from here.
export { verifyRelationContent } from './verify-mesh-canary.js';

/**
 * 2. Value-canary for high-value hot columns.
 *
 * verify-db checks column PRESENCE only — a column can exist yet be 100% NULL (a
 * PR-3 deep column silent-zeroing, or the gh `stars` projection dropping). We
 * sample top-FNI rows across ALL meta shards and assert a value is present.
 * CALIBRATION (2026-06-06, run 27053384921 false-positive post-mortem): a
 * value-canary may HARD-FAIL a bake ONLY on a field RELIABLY DENSE in the top-FNI
 * sample. Sparse / optional / cancelled-source fields must NOT hard-fail — they
 * use a SCOPED WARNING or are dropped — else they false-fire on a healthy corpus
 * and block every bake (this canary turned against itself).
 *   - `stars`     HARD-FAIL: dense for gh entities (thousands in sample); 0 = drop.
 *   - `num_heads` WARNING (scoped): only `model` rows with a deep config.json
 *                 (MoE/quantized) carry it, and that fetch is best-effort — a
 *                 top-FNI sample of papers/datasets/tools legitimately lacks it
 *                 (hard-failing false-fired the bake). Warn only if rows that
 *                 SHOULD (sibling num_layers/hidden_size set) are ALL null.
 *   - `sdk`       REMOVED: `space` type cancelled (#2142; SpacesAdapter.normalize
 *                 + hf-normalizer.normalizeSpace `return null`). No other producer,
 *                 so 0 is CORRECT — was guarding a dead field.
 */
const VALUE_DENSE_COLS = ['stars'];          // HARD-FAIL: reliably dense in top-FNI sample
const VALUE_SCOPED_COLS = ['num_heads'];     // WARNING: sparse/optional, scope to its sibling
const VALUE_SCOPE_SIBLINGS = ['num_layers', 'hidden_size']; // co-populated deep-config markers
const VALUE_SAMPLE_SIZE = 1000;

export function verifyHotColumnValues(dirPath, check) {
    const shardFiles = fs.readdirSync(dirPath)
        .filter(f => /^meta-\d+\.db$/.test(f))
        .map(f => path.join(dirPath, f));
    if (shardFiles.length === 0) return; // not a hash-sharded layout; nothing to do
    const allCols = [...VALUE_DENSE_COLS, ...VALUE_SCOPED_COLS, ...VALUE_SCOPE_SIBLINGS];
    const populated = Object.fromEntries(VALUE_DENSE_COLS.map(c => [c, 0]));
    let sampled = 0, scopedRows = 0, scopedOk = 0;
    // Merge each shard's local top-FNI slice; a hot row lives in exactly one
    // shard, so any populated value counts — only an all-shard total-null yields 0.
    for (const fp of shardFiles) {
        const db = new Database(fp, { readonly: true });
        try {
            const cols = db.prepare("PRAGMA table_info(entities)").all().map(c => c.name);
            const present = allCols.filter(c => cols.includes(c));
            if (present.length === 0) { db.close(); continue; }
            const rows = db.prepare(
                `SELECT ${present.join(', ')} FROM entities ORDER BY fni_score DESC LIMIT ${VALUE_SAMPLE_SIZE}`
            ).all();
            for (const r of rows) {
                sampled++;
                for (const c of VALUE_DENSE_COLS) if (isPopulated(r[c])) populated[c]++;
                // Scoped num_heads: only rows that SHOULD have it (a deep-config
                // sibling set) count toward the warning denominator.
                if (VALUE_SCOPE_SIBLINGS.some(s => isPopulated(r[s]))) {
                    scopedRows++;
                    if (VALUE_SCOPED_COLS.every(c => isPopulated(r[c]))) scopedOk++;
                }
            }
        } finally { db.close(); }
    }
    if (sampled === 0) { console.log('[VERIFY] Value canary: skipped (0 rows sampled)'); return; }
    for (const c of VALUE_DENSE_COLS) {
        check(`Value: ${c}`, populated[c] > 0, `${populated[c]} populated of ${sampled} sampled`);
    }
    // Non-fatal scoped warning: a num_heads-specific drop (siblings present, heads
    // all null) is suspicious, but corpus-wide sparsity must NOT block the bake.
    if (scopedRows === 0) {
        console.log('[VERIFY] Value: num_heads — skipped (no deep-config rows in sample)');
    } else {
        const warn = scopedOk === 0 ? '⚠️ ' : '';
        const tail = scopedOk === 0 ? ' (possible num_heads-specific drop; non-fatal)' : ' → ok';
        console.log(`[VERIFY] ${warn}Value: num_heads — ${scopedOk}/${scopedRows} deep-config rows populated${tail}`);
    }
}

/** Non-null, non-empty, non-zero — the "real value present" predicate. */
function isPopulated(v) {
    return v !== null && v !== undefined && v !== '' && v !== 0;
}

/**
 * 3. Bake-only producer floor checks.
 *
 * The bake writes binary artifacts the deploy CDN-warms with NO post-build
 * verification — any can ship empty/corrupt invisibly. We assert a magic-byte
 * header + record-count/size floor for each (mirroring verify-db's NXVF pattern);
 * legitimately-skippable artifacts are checked conditionally (only IF run).
 * Floors are tiny (existence + non-empty + sane magic), NOT scaled to corpus
 * size — they catch "wrote 0 records / wrong format / truncated" without
 * false-firing on a small corpus or a legitimately-skipped producer.
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

/**
 * P3-EVIDENCE-1: Citation integrity canary.
 *
 * Independently re-scans EVERY published meta-NN.db shard (not only meta-00.db --
 * a hot row lives in exactly one shard, so the citation population is sharded) and
 * fails the bake on any FABRICATED citation. Mirrors the producer contract
 * (umid-generator.normalizeCitation): title MANDATORY + genuine, no id/slug/hash
 * as title, no [object Object], no empty field shells, year only from the packed
 * source publication year (published_year) -- a CONFLICT fails, current/bake year
 * is NOT itself a violation (a real paper may be published this year).
 */
const CITATION_SAMPLE = /title=\{([^}]*)\}/;
const CITATION_YEAR = /year=\{([^}]*)\}/;
const SHELL_RE = /(title|author|year|url)=\{\s*\}/;
const HASH_LIKE = /^[0-9a-f]{16,}$/i; // umid / content-hash residue

export function verifyCitationIntegrity(dirPath, check) {
    const shardFiles = fs.readdirSync(dirPath).filter(f => /^meta-\d+\.db$/.test(f)).sort();
    if (shardFiles.length === 0) { console.log('[VERIFY] Citation: skipped (no meta-NN.db shards)'); return; }
    let rows = 0, cited = 0;
    const v = { objectObject: 0, idAsTitle: 0, shell: 0, noTitle: 0, residue: 0, yearConflict: 0 };
    for (const f of shardFiles) {
        const db = new Database(path.join(dirPath, f), { readonly: true });
        try {
            const cols = db.prepare('PRAGMA table_info(entities)').all().map(c => c.name);
            if (!cols.includes('citation')) { db.close(); continue; }
            const hasYear = cols.includes('published_year');
            const sel = `id, slug, citation${hasYear ? ', published_year' : ''} FROM entities`;
            for (const r of db.prepare(`SELECT ${sel}`).iterate()) {
                rows++;
                const c = r.citation;
                if (typeof c !== 'string' || !c) continue; // null citation is contract-valid
                cited++;
                if (c.includes('[object Object]')) v.objectObject++;
                if (SHELL_RE.test(c)) v.shell++;
                if (/url=\{\s*by Free2AITools\s*\}/i.test(c) || /url=\{\s*\/(papers|models?|datasets|tools|agents|spaces|prompts)\//i.test(c)) v.residue++;
                const tm = c.match(CITATION_SAMPLE);
                if (!tm) { v.noTitle++; }
                else {
                    const title = tm[1].trim();
                    if (!title) v.shell++;
                    else if (title === r.id || title === r.slug || HASH_LIKE.test(title) || /^unknown$/i.test(title)) v.idAsTitle++;
                }
                const ym = c.match(CITATION_YEAR);
                if (ym && hasYear && r.published_year != null) {
                    const cy = Number(ym[1].trim());
                    if (Number.isInteger(cy) && cy !== Number(r.published_year)) v.yearConflict++;
                }
            }
        } finally { db.close(); }
    }
    // Execution proof: scanned shard count + row count must both be > 0.
    check('Citation: shards scanned', shardFiles.length > 0 && rows > 0, `${shardFiles.length} shards, ${rows} rows, ${cited} cited`);
    check('Citation: no [object Object]', v.objectObject === 0, `${v.objectObject} of ${cited}`);
    check('Citation: no id/hash-as-title', v.idAsTitle === 0, `${v.idAsTitle} of ${cited}`);
    check('Citation: no empty shells', v.shell === 0, `${v.shell} of ${cited}`);
    check('Citation: title present', v.noTitle === 0, `${v.noTitle} of ${cited} lack title`);
    check('Citation: no url residue', v.residue === 0, `${v.residue} of ${cited}`);
    check('Citation: year vs source', v.yearConflict === 0, `${v.yearConflict} of ${cited} conflict`);
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
