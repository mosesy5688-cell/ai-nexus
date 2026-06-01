/**
 * V27.92 STEP-0 GATE — Paper round-trip diagnostic (READ-ONLY, no mutation).
 *
 * Hypothesis under test (round-trip-broken): a /paper/<urlslug> URL resolves
 * only if the page-time lookup key (`unknown--<urlslug>`) equals the entity's
 * stored `slug` or `id`. If most papers store a different form
 * (arxiv-paper--<id>, arxiv-paper--unknown--<sha>, ...), resolveVfsMetadata
 * misses → soft-404, matching the T1 observation (60.8% dead).
 *
 * Method: faithfully replay production round-trip per paper row —
 *   stored id --getRouteFromId('paper')--> /paper/<urlslug>
 *           --normalizeEntitySlug('paper') + unknown-- prefix--> lookup key
 *   round-trip OK  <=>  lookupKey === stored slug OR === stored id.
 * We import the REAL routing fn (getRouteFromId/stripPrefix are pure, no worker
 * deps) so the URL side cannot drift. normalizeEntitySlug's paper path is
 * inlined (its module imports cloudflare:workers, unavailable in Node).
 *
 * Read-side shard hashing is the suspected-broken layer, so we scan ALL
 * meta-*.db shards rather than trusting xxhash placement. Source = prod
 * meta-NN.db restored from R2 (NOT the divergent live API, NOT stale local
 * data/meta.db).
 *
 * GATE: broken rows present (lookupKey != stored slug/id) => round-trip-broken
 * confirmed => proceed to T3 fix. ~zero broken => STOP, redirect to
 * sitemap-drift branch (hypothesis falsified).
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getRouteFromId, stripPrefix } from '../../src/utils/mesh-routing-core.js';

const DATA_DIR = process.env.PROBE_DATA_DIR || './output/data';
const SAMPLE_BROKEN = 30;
const SAMPLE_OK = 12;

// Inlined paper-path of normalizeEntitySlug (entity-cache-reader-core.js) +
// the resolver's unknown-- prefixing (vfs-metadata-provider.ts:15-19).
function lookupKeyForPaperUrl(urlslug) {
    let normalized = stripPrefix(urlslug).replace(/[:/]/g, '--').toLowerCase();
    if (!normalized.includes('--')) normalized = `unknown--${normalized}`;
    return normalized;
}

// stored id -> production /paper/<urlslug>, or null if not paper-routable.
function urlslugForPaper(id) {
    const route = getRouteFromId(id, 'paper');
    if (typeof route !== 'string' || !route.startsWith('/paper/')) return null;
    return route.slice('/paper/'.length);
}

// Coarse structural form of a stored slug/id for distribution buckets:
// everything up to the last '--' (the prefix structure), '<no-sep>' if none.
function formKey(s) {
    if (!s) return '<empty>';
    const i = s.lastIndexOf('--');
    return i < 0 ? '<no-sep>' : s.slice(0, i);
}

function listMetaShards() {
    if (!fs.existsSync(DATA_DIR)) throw new Error(`DATA_DIR missing: ${DATA_DIR}`);
    const files = fs.readdirSync(DATA_DIR)
        .filter(f => /^meta-\d+\.db$/.test(f))
        .map(f => path.join(DATA_DIR, f));
    if (files.length === 0) throw new Error(`No meta-NN.db found in ${DATA_DIR}`);
    return files.sort();
}

function probe() {
    const shards = listMetaShards();
    console.log(`[STEP-0] Scanning ${shards.length} meta-NN.db shards in ${DATA_DIR}`);

    let total = 0, ok = 0, broken = 0, unroutable = 0;
    const brokenForms = new Map();   // stored-slug formKey -> count
    const okForms = new Map();
    const brokenSamples = [];
    const okSamples = [];

    for (const file of shards) {
        const db = new Database(file, { readonly: true });
        // Stream (P1): iterate keeps memory O(buckets+samples), not O(rows).
        const stmt = db.prepare(
            "SELECT id, slug FROM entities WHERE type = 'paper'");
        for (const row of stmt.iterate()) {
            total++;
            const id = row.id || '';
            const slug = row.slug || '';
            const urlslug = urlslugForPaper(id);
            if (!urlslug) {
                unroutable++;
                if (brokenSamples.length < SAMPLE_BROKEN)
                    brokenSamples.push({ id, slug, urlslug: '<unroutable>', key: '<n/a>' });
                continue;
            }
            const key = lookupKeyForPaperUrl(urlslug);
            const hit = key === slug.toLowerCase() || key === id.toLowerCase();
            if (hit) {
                ok++;
                okForms.set(formKey(slug), (okForms.get(formKey(slug)) || 0) + 1);
                if (okSamples.length < SAMPLE_OK)
                    okSamples.push({ id, slug, urlslug, key });
            } else {
                broken++;
                brokenForms.set(formKey(slug), (brokenForms.get(formKey(slug)) || 0) + 1);
                if (brokenSamples.length < SAMPLE_BROKEN)
                    brokenSamples.push({ id, slug, urlslug, key });
            }
        }
        db.close();
    }

    const pct = total ? ((broken + unroutable) / total * 100).toFixed(1) : '0.0';
    console.log('\n========== STEP-0 ROUND-TRIP RESULT ==========');
    console.log(`paper entities scanned : ${total}`);
    console.log(`round-trip OK          : ${ok}`);
    console.log(`round-trip BROKEN      : ${broken}`);
    console.log(`unroutable (no /paper/): ${unroutable}`);
    console.log(`DEAD (broken+unroutable): ${broken + unroutable} (${pct}%)`);

    const dump = (title, m) => {
        console.log(`\n-- ${title} (stored-slug form -> count) --`);
        [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
            .forEach(([k, v]) => console.log(`  ${String(v).padStart(8)}  ${k}--<id>`));
    };
    dump('BROKEN stored-slug form distribution', brokenForms);
    dump('OK stored-slug form distribution', okForms);

    const sample = (title, arr) => {
        console.log(`\n-- ${title} --`);
        arr.forEach(s => console.log(
            `  id=${s.id}\n    slug=${s.slug}\n    url=/paper/${s.urlslug}  lookupKey=${s.key}`));
    };
    sample(`BROKEN samples (up to ${SAMPLE_BROKEN})`, brokenSamples);
    sample(`OK samples (up to ${SAMPLE_OK})`, okSamples);

    console.log('\n========== GATE VERDICT ==========');
    if (total === 0) {
        console.log('INCONCLUSIVE: zero paper entities found. Check type column / shard set.');
        console.log('GATE=INCONCLUSIVE');
    } else if (broken + unroutable === 0) {
        console.log('FALSIFIED: every paper round-trips. Hypothesis wrong → STOP T3,');
        console.log('redirect to sitemap-drift branch (dead URLs are not corpus papers).');
        console.log('GATE=FALSIFIED');
    } else {
        console.log(`CONFIRMED: ${broken + unroutable}/${total} (${pct}%) papers fail round-trip.`);
        console.log('Stored slug/id form != unknown--<urlslug> → resolveVfsMetadata miss.');
        console.log('Proceed to T3: (b) resolver multi-form match using the forms above.');
        console.log('GATE=CONFIRMED');
    }
    console.log('==================================');
}

try {
    probe();
} catch (e) {
    console.error('[STEP-0] FATAL:', e.message);
    process.exit(1);
}
