/**
 * V27.93b STEP-0 GATE -- Mesh/relation telemetry probe (READ-ONLY, no mutation).
 *
 * Validates the V27.93 code-trace diagnosis with real PRODUCTION data. Source =
 * prod meta-NN.db restored from R2 state/vfs-data/ (NOT stale local
 * output/data/*.json, NOT public/cache/mesh_graph.json). Two layers are probed:
 *
 *  - Per-entity RELATION LIST: the `ui_related_mesh` column (entities table). Per
 *    the distiller (v25-distiller.js:163-170) it is a JSON array of
 *    { id, type, name, icon } when the target resolved, or
 *    { id, type, name:<targetId>, icon, _unresolved:1 } when it did not.
 *    It is NOT a {nodes,edges} graph -- that is the separate blob below.
 *  - Graph blob: site_metadata.mesh_graph (one decompressed JSON string injected
 *    into every meta shard, pack-utils.js:182-205). Shape:
 *    { _v, nodes:{id:{t,f}}, edges:{ source:[ [target,TYPE,weight] | {target,type,weight} ] } }
 *    (Rust producer emits the array tuple form; JS fallback emits the object form.)
 *
 * Metrics (read-only, falsifiable):
 *   A.1  relation-TYPE histogram across sampled entities. Signature of the bug:
 *        BASED_ON/TRAINED_ON/CITES/USES ~= 0 while STACK/EXPLAINS dominate.
 *   A.1c relations-per-entity distribution (0, 1, 2-4, 5-15, 15+) + %% zero / non-empty.
 *   A.2  degeneracy ratio: %% of relation entries missing id/name OR _unresolved
 *        truthy OR the bare {type,icon} shape (no id, no name).
 *   B    blob mass: LENGTH(value) of site_metadata.mesh_graph in MB (the ~76.6MB
 *        heap source) + a streamed graph-level edge-type count to cross-confirm A.1.
 *
 * GATE: prints an explicit VERDICT per metric. No write of any kind.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.PROBE_DATA_DIR || './output/data';
const PER_SHARD_LIMIT = Number(process.env.PROBE_PER_SHARD_LIMIT || 1000);
const REAL_TYPES = ['BASED_ON', 'TRAINED_ON', 'CITES', 'USES', 'IMPLEMENTS', 'DEMO_OF'];
const SAMPLE_RAW = 8;

function listMetaShards() {
    if (!fs.existsSync(DATA_DIR)) throw new Error(`DATA_DIR missing: ${DATA_DIR}`);
    const files = fs.readdirSync(DATA_DIR)
        .filter(f => /^meta-\d+\.db$/.test(f))
        .map(f => path.join(DATA_DIR, f));
    if (files.length === 0) throw new Error(`No meta-NN.db found in ${DATA_DIR}`);
    return files.sort();
}

// One relation entry is degenerate if it carries no usable target identity:
// id missing/blank OR name missing/blank OR _unresolved truthy. The bare
// {type,icon} shape (distiller never emits a name-less id-less real entry) is
// captured by the id+name-missing test -- detected by field presence, not by
// matching any emoji literal (keeps this file ASCII-only per CES Art 8.1).
function isDegenerate(rel) {
    if (!rel || typeof rel !== 'object') return true;
    if (rel._unresolved) return true;
    const hasId = typeof rel.id === 'string' && rel.id.trim() !== '';
    const hasName = typeof rel.name === 'string' && rel.name.trim() !== '';
    return !hasId || !hasName;
}

function bucketCount(n) {
    if (n === 0) return '0';
    if (n === 1) return '1';
    if (n <= 4) return '2-4';
    if (n <= 15) return '5-15';
    return '15+';
}

function probeEntities(shards, acc) {
    for (const file of shards) {
        const db = new Database(file, { readonly: true });
        const stmt = db.prepare(
            'SELECT id, type, fni_score, ui_related_mesh FROM entities ' +
            'ORDER BY fni_score DESC LIMIT ?');
        for (const row of stmt.iterate(PER_SHARD_LIMIT)) {
            acc.entities++;
            let rels;
            try { rels = JSON.parse(row.ui_related_mesh || '[]'); }
            catch { rels = []; acc.parseErrors++; }
            if (!Array.isArray(rels)) { rels = []; acc.parseErrors++; }
            const n = rels.length;
            acc.perEntity.set(bucketCount(n), (acc.perEntity.get(bucketCount(n)) || 0) + 1);
            if (n === 0) acc.zeroRel++; else acc.nonEmpty++;
            for (const rel of rels) {
                acc.relTotal++;
                const t = (rel && rel.type) ? String(rel.type) : '<none>';
                acc.typeHist.set(t, (acc.typeHist.get(t) || 0) + 1);
                if (isDegenerate(rel)) acc.degenerate++;
                if (acc.rawSamples.length < SAMPLE_RAW && n > 0)
                    acc.rawSamples.push({ id: row.id, type: row.type, rel });
            }
        }
        db.close();
    }
}

// Read the mesh_graph blob size from one shard (all shards share it). Get its
// byte length via SQL LENGTH() so we never load 76.6MB into the V8 heap. Then
// stream the value in fixed chunks and tally edge-type tokens with a regex,
// guarding memory: no JSON.parse of the whole blob.
function probeBlob(shards) {
    const out = { mb: null, bySource: null, edgeTypes: new Map(), scanned: false };
    for (const file of shards) {
        const db = new Database(file, { readonly: true });
        const lenRow = db.prepare(
            "SELECT LENGTH(value) AS len FROM site_metadata WHERE key = 'mesh_graph'").get();
        if (lenRow && lenRow.len != null) {
            out.mb = (lenRow.len / (1024 * 1024)).toFixed(2);
            out.bySource = path.basename(file);
            scanEdgeTypes(db, out);
            db.close();
            break;
        }
        db.close();
    }
    return out;
}

// Stream the blob in 4MB SQL substring windows and count edge-type tokens.
// Edge tuples look like ["<id>","BASED_ON",100] (Rust) or {"type":"CITES"} (JS),
// so we match an ALL-CAPS token list. Window overlap avoids splitting a token.
function scanEdgeTypes(db, out) {
    const len = db.prepare(
        "SELECT LENGTH(value) AS len FROM site_metadata WHERE key='mesh_graph'").get().len;
    const sub = db.prepare(
        "SELECT SUBSTR(value, ?, ?) AS chunk FROM site_metadata WHERE key='mesh_graph'");
    const CHUNK = 4 * 1024 * 1024, OVERLAP = 64;
    const re = /\b([A-Z][A-Z_]{2,})\b/g;
    let pos = 1;
    while (pos <= len) {
        const r = sub.get(pos, CHUNK + OVERLAP);
        if (!r || !r.chunk) break;
        let m;
        while ((m = re.exec(r.chunk)) !== null) {
            const tok = m[1];
            out.edgeTypes.set(tok, (out.edgeTypes.get(tok) || 0) + 1);
        }
        pos += CHUNK;
    }
    out.scanned = true;
}

function dumpHist(title, map, limit) {
    console.log(`\n-- ${title} --`);
    const rows = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit || 40);
    if (rows.length === 0) { console.log('  (none)'); return; }
    rows.forEach(([k, v]) => console.log(`  ${String(v).padStart(10)}  ${k}`));
}

function report(acc, blob) {
    console.log('\n========== V27.93b MESH TELEMETRY RESULT ==========');
    console.log(`entities sampled   : ${acc.entities}`);
    console.log(`relation entries   : ${acc.relTotal}`);
    console.log(`parse errors       : ${acc.parseErrors}`);
    const zeroPct = acc.entities ? (acc.zeroRel / acc.entities * 100).toFixed(1) : '0.0';
    const nePct = acc.entities ? (acc.nonEmpty / acc.entities * 100).toFixed(1) : '0.0';
    console.log(`entities zero-rel  : ${acc.zeroRel} (${zeroPct}%)`);
    console.log(`entities non-empty : ${acc.nonEmpty} (${nePct}%)`);

    dumpHist('A.1 relation-TYPE histogram (column ui_related_mesh)', acc.typeHist);

    console.log('\n-- A.1c relations-per-entity distribution --');
    for (const b of ['0', '1', '2-4', '5-15', '15+'])
        console.log(`  ${String(acc.perEntity.get(b) || 0).padStart(10)}  ${b} relations`);

    const degPct = acc.relTotal ? (acc.degenerate / acc.relTotal * 100).toFixed(1) : '0.0';
    console.log('\n-- A.2 degeneracy --');
    console.log(`  degenerate entries : ${acc.degenerate} / ${acc.relTotal} (${degPct}%)`);

    console.log('\n-- raw ui_related_mesh samples (shape confirmation) --');
    acc.rawSamples.forEach(s => console.log(
        `  src=${s.id} (${s.type}) -> ${JSON.stringify(s.rel)}`));

    console.log('\n-- B blob mass: site_metadata.mesh_graph --');
    if (blob.mb == null) {
        console.log('  mesh_graph: NOT FOUND in any shard');
    } else {
        console.log(`  source shard : ${blob.bySource}`);
        console.log(`  size         : ${blob.mb} MB`);
        dumpHist('B graph-level ALL-CAPS token histogram (edge-type cross-confirm)',
            blob.edgeTypes, 30);
    }

    verdict(acc, blob, degPct);
}

function verdict(acc, blob, degPct) {
    console.log('\n========== GATE VERDICT ==========');
    const real = REAL_TYPES.reduce((s, t) => s + (acc.typeHist.get(t) || 0), 0);
    const stack = acc.typeHist.get('STACK') || 0;
    const explains = acc.typeHist.get('EXPLAINS') || 0;
    if (acc.entities === 0) {
        console.log('A.1 INCONCLUSIVE: zero entities scanned. Check shard set / column.');
    } else if (real === 0 && (stack + explains) > 0) {
        console.log(`A.1 CONFIRMED: real types (BASED_ON/TRAINED_ON/CITES/USES/...) = ${real} (~=0), ` +
            `STACK=${stack} EXPLAINS=${explains} dominate.`);
    } else {
        console.log(`A.1 NOT-CONFIRMED: real types = ${real}, STACK=${stack}, EXPLAINS=${explains}. ` +
            'Inspect histogram above.');
    }
    if (acc.relTotal === 0) console.log('A.2 INCONCLUSIVE: zero relation entries to classify.');
    else if (Number(degPct) >= 50) console.log(`A.2 CONFIRMED: ${degPct}% of relation entries degenerate.`);
    else console.log(`A.2 NOT-CONFIRMED: ${degPct}% degenerate (<50%).`);
    if (blob.mb == null) console.log('B INCONCLUSIVE: mesh_graph blob absent.');
    else if (Number(blob.mb) >= 40) console.log(`B CONFIRMED: mesh_graph = ${blob.mb} MB (heavy heap source).`);
    else console.log(`B NOTE: mesh_graph = ${blob.mb} MB (below 40MB heap-risk threshold).`);
    console.log('==================================');
}

function probe() {
    const shards = listMetaShards();
    console.log(`[V27.93b] Scanning ${shards.length} meta-NN.db shards in ${DATA_DIR}`);
    console.log(`[V27.93b] Per-shard top-FNI sample limit: ${PER_SHARD_LIMIT}`);
    const acc = {
        entities: 0, relTotal: 0, parseErrors: 0, zeroRel: 0, nonEmpty: 0,
        degenerate: 0, typeHist: new Map(), perEntity: new Map(), rawSamples: [],
    };
    probeEntities(shards, acc);
    const blob = probeBlob(shards);
    report(acc, blob);
}

try {
    probe();
} catch (e) {
    console.error('[V27.93b] FATAL:', e.message);
    process.exit(1);
}
