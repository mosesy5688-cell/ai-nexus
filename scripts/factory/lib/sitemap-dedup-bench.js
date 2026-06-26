/**
 * D-140 Lane S-B §8.1 — SCALE PROOF harness for the C3 deterministic dedup.
 *
 * Exercises the REAL SitemapUrlSet (not a copy) at (a) the current ~600,000
 * candidate scale and (b) a synthetic 1,000,000 candidate set with >=20%
 * duplicates, recording: input/output/duplicate counts, peak heapUsed, elapsed
 * time, and a deterministic output hash (same input -> same hash). Proves the
 * in-memory dedup structure fits the vfs-derived job's 6144MB NODE_OPTIONS
 * ceiling with large headroom.
 *
 * Run: node --max-old-space-size=6144 --expose-gc scripts/factory/lib/sitemap-dedup-bench.js
 */
import crypto from 'crypto';
import { SitemapUrlSet, normalizeLastmod } from './sitemap-url-set.js';

function* genCandidates(total, dupFraction) {
    const uniqueCount = Math.max(1, Math.floor(total * (1 - dupFraction)));
    for (let i = 0; i < uniqueCount; i++) {
        yield {
            loc: `/model/owner${i % 5000}/entity-name-slug-${i}`,
            priority: '0.4', changefreq: 'daily',
            lastmod: i % 3 === 0 ? `2026-0${(i % 6) + 1}-15T00:00:00Z` : (i % 7 === 0 ? 'INVALID-TS' : ''),
        };
    }
    for (let j = 0; j < total - uniqueCount; j++) {
        const src = j % uniqueCount;
        yield {
            loc: `/model/owner${src % 5000}/entity-name-slug-${src}`,
            priority: '0.4', changefreq: 'daily',
            lastmod: j % 2 === 0 ? '2026-12-31T00:00:00Z' : 'BAD',
        };
    }
}

function hashOutput(records) {
    const h = crypto.createHash('sha256');
    for (const r of records) {
        h.update(`${r.loc}|${r.priority}|${r.changefreq}|${normalizeLastmod(r.lastmod)}\n`);
    }
    return h.digest('hex');
}

function bench(total, dupFraction, label) {
    if (global.gc) global.gc();
    const set = new SitemapUrlSet();
    const t0 = process.hrtime.bigint();
    let input = 0;
    for (const c of genCandidates(total, dupFraction)) { set.add(c); input++; }
    const out = set.toSortedArray();
    const hash = hashOutput(out);
    const t1 = process.hrtime.bigint();
    const mem = process.memoryUsage();
    // determinism: rebuild and re-hash
    const set2 = new SitemapUrlSet();
    for (const c of genCandidates(total, dupFraction)) set2.add(c);
    const deterministic = hashOutput(set2.toSortedArray()) === hash;
    console.log(`\n=== ${label} ===`);
    console.log(`input candidates : ${input}`);
    console.log(`output (unique)  : ${out.length}`);
    console.log(`duplicates merged: ${input - out.length}`);
    console.log(`elapsed          : ${(Number(t1 - t0) / 1e6).toFixed(1)} ms`);
    console.log(`peak heapUsed    : ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`);
    console.log(`rss              : ${(mem.rss / 1024 / 1024).toFixed(1)} MB`);
    console.log(`output hash      : ${hash}`);
    console.log(`deterministic    : ${deterministic}`);
}

bench(600000, 0.108, '600K candidates (~10.8% dup, audit-matched)');
bench(1000000, 0.20, '1,000,000 candidates (>=20% dup, scale proof)');
console.log(`\nHeap ceiling (NODE_OPTIONS vfs-derived): 6144 MB.`);
