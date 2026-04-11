/**
 * V∞ Phase 1A-β: Static Inverted Index Builder
 * Builds offline term_index/*.json.zst files for CDN/R2-based search.
 * Runs in GHA CI after shard packing (Phase 7 of pack-db.js).
 */
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { zstdCompress } from './zstd-helper.js';
import { computeMetaShardSlot } from './meta-shard-router.js';
import { META_SHARD_COUNT } from '../../../src/constants/shard-constants.js';

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

/**
 * Build static inverted index from search.db.
 * @param {string} searchDbPath - Path to search.db
 * @param {string} outputDir - Output directory (e.g. ./output/term_index)
 */
export async function buildInvertedIndex(searchDbPath, outputDir) {
    console.log('[InvIdx] Building static inverted index...');
    const db = new Database(searchDbPath, { readonly: true });

    const stmt = db.prepare(
        `SELECT id, slug, name, type, author, summary, tags, category, fni_score
         FROM entities ORDER BY fni_score DESC`
    );

    // ── Pass 1: Build term → postings map + collect doc lengths ──
    const termMap = new Map();
    let totalDocs = 0, totalLen = 0;

    for (const row of stmt.iterate()) {
        const fields = [row.name, row.summary, row.tags, row.category, row.author];
        const terms = tokenize(fields.join(' '));
        if (terms.length === 0) continue;

        totalDocs++;
        totalLen += terms.length;
        const shard = computeMetaShardSlot(row.slug || row.id, META_SHARD_COUNT);

        for (const term of terms) {
            let entry = termMap.get(term);
            if (!entry) { entry = []; termMap.set(term, entry); }
            entry.push([row.id, Math.round(row.fni_score || 0), shard]);
        }
    }
    db.close();

    const avgDl = totalDocs > 0 ? totalLen / totalDocs : 1;
    console.log(`[InvIdx] ${totalDocs} docs, ${termMap.size} unique terms, avgDl=${avgDl.toFixed(1)}`);

    // ── Pass 2: Write term files (pure FNI scores — BM25 computed at query time) ──
    let filesWritten = 0, totalBytes = 0;

    for (const [term, postings] of termMap) {
        const df = postings.length;
        postings.sort((a, b) => b[1] - a[1]);

        // Prefix bucket: 2-char prefix directory
        const prefix = term.length >= 2 ? term.slice(0, 2) : term.padEnd(2, '_');
        const bucketDir = join(outputDir, prefix);
        mkdirSync(bucketDir, { recursive: true });

        if (df > HIGH_FREQ_THRESHOLD) {
            // High-frequency term: shard into chunks
            const chunks = Math.ceil(postings.length / HIGH_FREQ_CHUNK_SIZE);
            for (let i = 0; i < chunks; i++) {
                const chunk = postings.slice(i * HIGH_FREQ_CHUNK_SIZE, (i + 1) * HIGH_FREQ_CHUNK_SIZE);
                const json = JSON.stringify({ term, df, chunk: i, chunks, postings: chunk });
                const compressed = await zstdCompress(Buffer.from(json), 3);
                const fname = `${term}_${i}.json.zst`;
                writeFileSync(join(bucketDir, fname), compressed);
                filesWritten++; totalBytes += compressed.length;
            }
        } else {
            const json = JSON.stringify({ term, df, postings });
            const compressed = await zstdCompress(Buffer.from(json), 3);
            writeFileSync(join(bucketDir, `${term}.json.zst`), compressed);
            filesWritten++; totalBytes += compressed.length;
        }
    }

    // ── Write manifest ──
    const manifest = {
        version: 'inverted_v1',
        built: new Date().toISOString(),
        total_docs: totalDocs,
        total_terms: termMap.size,
        total_files: filesWritten,
        total_bytes: totalBytes,
        avg_doc_length: Math.round(avgDl * 10) / 10,
        high_freq_threshold: HIGH_FREQ_THRESHOLD,
        shard_count: META_SHARD_COUNT
    };
    const mJson = JSON.stringify(manifest, null, 2);
    const mCompressed = await zstdCompress(Buffer.from(mJson), 3);
    writeFileSync(join(outputDir, '_manifest.json.zst'), mCompressed);

    console.log(`[InvIdx] ✅ Complete: ${filesWritten} files, ${(totalBytes / 1024 / 1024).toFixed(1)}MB compressed`);
    return manifest;
}
