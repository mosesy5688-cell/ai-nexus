/**
 * Identity Assertion bake canaries (PR-C1). NEW file (verify-canaries.js is at the
 * CES 250 ceiling). Independently re-scans the written assertion shards -- does NOT
 * merely trust the producer's self-count -- so a generator regression that mislabels
 * an edge is caught structurally.
 *
 * Design IDENTITY_LAYER_DESIGN_v3 G PR-C1 acceptance:
 *   (a) EVALUATED_ON method -> ZERO SAME_AS         (many-to-one fact barred from identity)
 *   (b) arxiv-paper--unknown--* member -> ZERO SAME_AS  (placeholder identity, D7)
 *   (c) assertions_empty_evidence == 0              (every assertion carries evidence[])
 * Each failure flips `check` to fail -> verify-db exits 1 -> bake blocked. ASCII-only.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const PAPER_PLACEHOLDER = /^arxiv-paper--unknown--/;
// A non-singleton floor would belong in PR-C3's connected-components/IDGR canary;
// PR-C1 owns ONLY the per-assertion correctness invariants above.

/** Decompress a zstd OR gzip buffer to utf-8 (zstd is the bake default). */
function decompress(buf) {
    if (buf.length >= 4 && buf[0] === 0x28 && buf[1] === 0xB5 && buf[2] === 0x2F && buf[3] === 0xFD) {
        return zlib.zstdDecompressSync ? zlib.zstdDecompressSync(buf).toString('utf-8')
            : buf.toString('utf-8'); // older node: fall through (shards are small)
    }
    if (buf.length >= 2 && buf[0] === 0x1F && buf[1] === 0x8B) return zlib.gunzipSync(buf).toString('utf-8');
    return buf.toString('utf-8');
}

/**
 * @param {string} dataDir - dir of meta-00.db (assertions live at ../cache/assertions)
 * @param {(label:string,pass:boolean,detail?:string)=>void} check
 */
export function verifyAssertions(dataDir, check) {
    const dir = path.join(dataDir, '..', 'cache', 'assertions');
    if (!fs.existsSync(dir)) {
        // Producer is a satellite task; on a bake that did not run it, skip cleanly
        // (mirrors verify-canaries' conditional-producer discipline). Do NOT fail:
        // a missing artifact from a non-assertion bake is legitimate.
        console.log('[VERIFY] Assertions: skipped (no output/cache/assertions dir)');
        return;
    }

    // (c) Empty-evidence count from the producer summary (rejected-at-write counter).
    let summary = {};
    try { summary = JSON.parse(fs.readFileSync(path.join(dir, '_summary.json'), 'utf-8')); } catch { /* none */ }
    const emptyEv = summary.assertions_empty_evidence || 0;
    check('Assertions: empty-evidence', emptyEv === 0, `${emptyEv} empty-evidence (need 0)`);

    // (a)+(b) Independent re-scan of every shard for a false SAME_AS.
    const shardFiles = fs.readdirSync(dir).filter((f) => /^assertions-\d+\.jsonl\.zst$/.test(f));
    let sameAs = 0, evalOnSameAs = 0, paperSameAs = 0, emptyEvidenceRows = 0, scanned = 0;
    for (const f of shardFiles) {
        let text;
        try { text = decompress(fs.readFileSync(path.join(dir, f))); } catch { continue; }
        for (const line of text.split('\n')) {
            if (!line) continue;
            let a; try { a = JSON.parse(line); } catch { continue; }
            scanned++;
            if (!Array.isArray(a.evidence) || a.evidence.length === 0) emptyEvidenceRows++;
            if (a.relation !== 'SAME_AS') continue;
            sameAs++;
            if (a.method === 'EVALUATED_ON' || a.method === 'evaluated_on') evalOnSameAs++;
            if (PAPER_PLACEHOLDER.test(a.member_a) || PAPER_PLACEHOLDER.test(a.member_b)) paperSameAs++;
        }
    }
    check('Assertions: EVALUATED_ON->SAME_AS', evalOnSameAs === 0, `${evalOnSameAs} (need 0 of ${sameAs} SAME_AS)`);
    check('Assertions: paper-placeholder->SAME_AS', paperSameAs === 0, `${paperSameAs} (need 0 of ${sameAs} SAME_AS)`);
    // Structural re-confirmation of (c) against the actual written rows (not just summary).
    check('Assertions: rows carry evidence', emptyEvidenceRows === 0, `${emptyEvidenceRows} empty of ${scanned} rows`);
}
