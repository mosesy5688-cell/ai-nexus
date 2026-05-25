/**
 * V∞ Phase 1A-β: Static Inverted Index Builder
 * Builds offline term_index/*.json.zst files for CDN/R2-based search.
 * Runs in GHA CI after shard packing (Phase 7 of pack-db.js).
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { zstdCompress } from './zstd-helper.js';
import { computeMetaShardSlot } from './meta-shard-router.js';
import { META_SHARD_COUNT } from '../../../src/constants/shard-constants.js';
import { writeBucketAccum } from './inverted-index-bucket-writer.js';

// V∞ fix: shard slot MUST align with pack-db's META_SHARD_COUNT (currently 96).
// Prior hardcoded SHARD_COUNT=40 left ~58% of entities unreachable via Tier 1
// because postings pointed to the wrong meta-NN.db shard (h%40 ≠ h%96).
const HIGH_FREQ_THRESHOLD = 10000;
const HIGH_FREQ_CHUNK_SIZE = 5000;
const STOP_WORDS = new Set([
    'a','an','the','and','or','but','in','on','at','to','for','of','is','it',
    'by','with','as','be','was','are','been','from','has','had','have','that',
    'this','not','no','will','can','all','its','than','into','also','may',
    'such','when','which','where','who','how','what','would','could','should',
    'about','over','between','through','after','before','during','under','above'
]);

// ── Minimal Porter Stemmer (suffix stripping, covers 90%+ of English) ──
const STEP2 = [
    [/ational$/, 'ate'], [/tional$/, 'tion'], [/enci$/, 'ence'],
    [/anci$/, 'ance'], [/izer$/, 'ize'], [/alli$/, 'al'],
    [/entli$/, 'ent'], [/eli$/, 'e'], [/ousli$/, 'ous'],
    [/ization$/, 'ize'], [/ation$/, 'ate'], [/ator$/, 'ate'],
    [/alism$/, 'al'], [/iveness$/, 'ive'], [/fulness$/, 'ful'],
    [/ousness$/, 'ous'], [/aliti$/, 'al'], [/iviti$/, 'ive'],
    [/biliti$/, 'ble'], [/logi$/, 'log']
];
const STEP3 = [
    [/icate$/, 'ic'], [/ative$/, ''], [/alize$/, 'al'],
    [/iciti$/, 'ic'], [/ical$/, 'ic'], [/ful$/, ''], [/ness$/, '']
];

function porterStem(w) {
    if (w.length < 3) return w;
    if (w.endsWith('ies') && w.length > 4) w = w.slice(0, -3) + 'i';
    else if (w.endsWith('sses')) w = w.slice(0, -2);
    else if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) w = w.slice(0, -1);
    if (w.endsWith('eed')) { if (w.length > 4) w = w.slice(0, -1); }
    else if (w.endsWith('ed') && /[aeiou]/.test(w.slice(0, -2))) w = w.slice(0, -2);
    else if (w.endsWith('ing') && /[aeiou]/.test(w.slice(0, -3))) w = w.slice(0, -3);
    if (w.endsWith('y') && w.length > 2 && !/[aeiou]/.test(w[w.length - 2])) {
        w = w.slice(0, -1) + 'i';
    }
    for (const [re, rep] of STEP2) { if (re.test(w)) { w = w.replace(re, rep); break; } }
    for (const [re, rep] of STEP3) { if (re.test(w)) { w = w.replace(re, rep); break; } }
    if (w.endsWith('ement') && w.length > 6) w = w.slice(0, -5);
    else if (w.endsWith('ment') && w.length > 5) w = w.slice(0, -4);
    else if (w.endsWith('ent') && w.length > 4) w = w.slice(0, -3);
    else if (w.endsWith('ant') && w.length > 4) w = w.slice(0, -3);
    else if (w.endsWith('ence') && w.length > 5) w = w.slice(0, -4);
    else if (w.endsWith('ance') && w.length > 5) w = w.slice(0, -4);
    else if (w.endsWith('ible') && w.length > 5) w = w.slice(0, -4);
    else if (w.endsWith('able') && w.length > 5) w = w.slice(0, -4);
    else if (w.endsWith('ion') && w.length > 4 && /[st]/.test(w[w.length - 4])) w = w.slice(0, -3);
    else if (w.endsWith('er') && w.length > 3) w = w.slice(0, -2);
    else if (w.endsWith('ou') && w.length > 3) w = w.slice(0, -2);
    if (w.endsWith('ll') && w.length > 3) w = w.slice(0, -1);
    return w;
}

/** Tokenize text into stemmed terms, filtering stop words and short tokens */
function tokenize(text) {
    if (!text) return [];
    const raw = String(text).toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 2 && t.length <= 40 && !STOP_WORDS.has(t));
    return [...new Set(raw.map(porterStem).filter(t => t.length >= 2 && t.length <= 40))];
}

/** V26.5: Build inverted index from meta-NN.db shards (search.db eliminated). V27.58: 2-tier with prefix-bucket consolidation. */
export async function buildInvertedIndexFromShards(metaDbs, outputDir) {
    console.log('[InvIdx] Building static inverted index from meta shards...');
    const termMap = new Map();
    let totalDocs = 0, totalLen = 0;

    for (const [, db] of Object.entries(metaDbs)) {
        const stmt = db.prepare(
            `SELECT id, slug, name, type, author, summary, tags, category, fni_score FROM entities ORDER BY fni_score DESC`
        );
        for (const row of stmt.iterate()) {
            const fields = [row.name, row.summary, row.tags, row.category, row.author];
            const terms = tokenize(fields.join(' '));
            if (terms.length === 0) continue;
            totalDocs++; totalLen += terms.length;
            const shard = computeMetaShardSlot(row.slug || row.id, META_SHARD_COUNT);
            for (const term of terms) {
                let entry = termMap.get(term);
                if (!entry) { entry = []; termMap.set(term, entry); }
                entry.push([row.id, Math.round(row.fni_score || 0), shard]);
            }
        }
    }

    const avgDl = totalDocs > 0 ? totalLen / totalDocs : 1;
    console.log(`[InvIdx] ${totalDocs} docs, ${termMap.size} unique terms, avgDl=${avgDl.toFixed(1)}`);

    // V27.59: Bucket-only path. df > HIGH_FREQ_THRESHOLD → individual chunked
    // files (hot-cache locality preserved); else → accumulated per 2-char prefix
    // and written as one _bucket.json.zst. V27.58 double-write of v1 individual
    // files removed: it added 382K per-file PUTs to V27.51 backup-dir each cycle
    // and crashed the 256B BLOCKED guard on long-tail (df≤3) terms.
    let highFreqFiles = 0, highFreqBytes = 0;
    let highFreqCount = 0, bucketedTermCount = 0;
    const bucketAccum = new Map();  // prefix -> { term: postings[] }

    for (const [term, postings] of termMap) {
        const df = postings.length;
        postings.sort((a, b) => b[1] - a[1]);
        const prefix = term.length >= 2 ? term.slice(0, 2) : term.padEnd(2, '_');
        const bucketDir = join(outputDir, prefix);
        mkdirSync(bucketDir, { recursive: true });
        if (df > HIGH_FREQ_THRESHOLD) {
            const chunks = Math.ceil(postings.length / HIGH_FREQ_CHUNK_SIZE);
            for (let i = 0; i < chunks; i++) {
                const chunk = postings.slice(i * HIGH_FREQ_CHUNK_SIZE, (i + 1) * HIGH_FREQ_CHUNK_SIZE);
                const compressed = await zstdCompress(Buffer.from(JSON.stringify({ term, df, chunk: i, chunks, postings: chunk })), 3);
                writeFileSync(join(bucketDir, `${term}_${i}.json.zst`), compressed);
                highFreqFiles++; highFreqBytes += compressed.length;
            }
            highFreqCount++;
        } else {
            let bucket = bucketAccum.get(prefix);
            if (!bucket) { bucket = {}; bucketAccum.set(prefix, bucket); }
            bucket[term] = { df, postings };
            bucketedTermCount++;
        }
    }

    // V27.59: write v2 prefix buckets via extracted helper.
    const { bucketsWritten, bucketBytes, maxBucketBytes, maxBucketPrefix } = await writeBucketAccum(bucketAccum, outputDir);
    console.log(`[InvIdx] v2_bucketed: ${bucketsWritten} prefix buckets, ${bucketedTermCount} terms, ${(bucketBytes/1024/1024).toFixed(2)}MB; max bucket '${maxBucketPrefix}'=${(maxBucketBytes/1024).toFixed(1)}KB`);
    console.log(`[InvIdx] high-freq: ${highFreqCount} terms, ${highFreqFiles} chunked files, ${(highFreqBytes/1024/1024).toFixed(2)}MB`);

    const manifest = {
        version: 'inverted_v2_bucketed',
        built: new Date().toISOString(),
        total_docs: totalDocs,
        total_terms: termMap.size,
        bucketed_term_count: bucketedTermCount,
        bucket_count: bucketsWritten,
        high_freq_term_count: highFreqCount,
        high_freq_file_count: highFreqFiles,
        total_bytes: highFreqBytes + bucketBytes,
        avg_doc_length: Math.round(avgDl * 10) / 10,
        high_freq_threshold: HIGH_FREQ_THRESHOLD,
        shard_count: META_SHARD_COUNT
    };
    writeFileSync(join(outputDir, '_manifest.json.zst'), await zstdCompress(Buffer.from(JSON.stringify(manifest, null, 2)), 3));
    console.log(`[InvIdx] ✅ Total buckets written: ${bucketsWritten} + ${highFreqFiles} high-freq chunks = ${bucketsWritten + highFreqFiles} files, ${((highFreqBytes + bucketBytes)/1024/1024).toFixed(1)}MB total`);
    return manifest;
}
