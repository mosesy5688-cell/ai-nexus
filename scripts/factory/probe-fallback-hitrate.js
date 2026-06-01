/**
 * V27.98 FALLBACK HIT-RATE PROBE — does the page resolver's +/-2 adjacent-shard
 * fallback resolve anything the per-candidate primary probe cannot? (READ-ONLY,
 * no mutation). Mirrors the V27.92 step-0 probe pattern (probe-paper-slugs.js):
 * scan ALL meta-NN.db shards, import the REAL pure routing/hashing functions the
 * resolver uses (zero drift), inline the TS-only candidate logic the Node
 * factory cannot import (same blocker step-0 hit), stream rows with .iterate().
 *
 * vfs-metadata-provider.ts builds per-URL candidates, hashes EACH to its OWN
 * meta shard (PRIMARY probe), then probes the +/-2 ADJACENT shards of
 * xxhash64Mod(candidates[0]) (FALLBACK). We want to DROP the +/-2 fallback (up
 * to 4 cold R2-VFS opens that push cold dead URLs into a transient/503 instead
 * of a clean 404, suspected redundant after per-candidate sharding). Before
 * removing, MEASURE over the whole prod corpus what the fallback UNIQUELY saves.
 *
 * Replay (per entity, from its canonical URL): id --getRouteFromId(id,type)-->
 * /<type>/<urlslug> --(paper page strips leading arxiv./s2.)--> urlslug
 * --normalizeEntitySlug(urlslug,type)--> normalized --(paper?
 * generatePaperCandidates : [normalized])--> candidates. Packer placement:
 * storedShard = xxhash64Mod(slug || id, META_SHARD_COUNT).
 *
 * Classes: primary-resolvable = some candidate c with xxhash64Mod(c)==storedShard
 * AND (c==slug OR c==id) (found WITHOUT fallback). fallback-only = NOT primary
 * but storedShard within +/-2 of xxhash64Mod(candidates[0]) AND some candidate
 * c==slug OR c==id (the fallback's WHERE slug=c OR id=c matches on that adjacent
 * shard) — EXACTLY what dropping +/-2 loses. unroutable = neither (no candidate
 * equals slug/id on any probed shard; a pre-existing gap, not caused by the drop).
 *
 * Source = prod meta-NN.db restored from R2 state/vfs-data/ (NOT the live API,
 * NOT stale local data/meta.db). No R2 mutation. VERDICT: fallback-only ~0 =>
 * SAFE TO DROP; > 0 => inspect its form distribution (if category-tail
 * arxiv--cs--<id> papers, fix THEIR candidate generation first).
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getRouteFromId, stripPrefix } from '../../src/utils/mesh-routing-core.js';
import { xxhash64Mod } from '../../src/utils/xxhash64-core.js';
import { META_SHARD_COUNT } from '../../src/constants/shard-constants.js';

// Inlined VERBATIM from src/lib/slug-helper.ts:60-73 (generatePaperCandidates).
// That module is TypeScript-only and the Node factory has no TS loader, so it
// cannot be imported here as a .js specifier — the same blocker the V27.92
// step-0 probe hit with normalizeEntitySlug (cloudflare:workers import). Kept
// byte-for-byte and MUST stay in lockstep with slug-helper.ts on any change to
// the candidate logic. xxhash64Mod / getRouteFromId / META_SHARD_COUNT are the
// REAL imports above (zero drift on the hashing + routing the resolver uses).
function generatePaperCandidates(normalized) {
    const bare = (normalized || '').toLowerCase();
    if (!bare) return [];
    const candidates = new Set();
    if (bare.includes('--')) {
        candidates.add(bare);
    } else {
        candidates.add(`arxiv--${bare}`);
        candidates.add(bare);
        candidates.add(`unknown--${bare}`);
    }
    return [...candidates].filter(Boolean);
}

const DATA_DIR = process.env.PROBE_DATA_DIR || './output/data';
const SAMPLE_N = 25;
const FALLBACK_RADIUS = 2; // mirrors the resolver's `offset <= 2` loop.

// Inlined paper-path of normalizeEntitySlug (entity-cache-reader-core.js:8-30):
// non-date/non-report input -> stripPrefix(slug).replace([:/]->--), lowercased
// by the resolver. The report date-format guard never fires for urlslug input.
// Inlined because the real module imports cloudflare:workers (step-0 precedent).
function normalizeUrlSlug(urlslug) {
    return stripPrefix(urlslug).replace(/[:\/]/g, '--').toLowerCase();
}

// stored id -> canonical /<type>/<urlslug> the page route sees, or null if not a
// routable entity page (e.g. '#', /search, /ranking category). Replays
// getRouteFromId + the paper page's arxiv./s2. strip (paper [...slug].astro:28).
function urlSlugForEntity(id, type) {
    const route = getRouteFromId(id, type);
    if (typeof route !== 'string' || route === '#' || route.startsWith('/search')) return null;
    // Routable entity pages: /<routeType>/<slug>. Categories route to /ranking/...
    const m = route.match(/^\/(model|dataset|space|agent|tool|prompt|paper|reports|knowledge)\/(.+)$/);
    if (!m) return null;
    let urlslug = m[2];
    if (m[1] === 'paper') urlslug = urlslug.replace(/^(arxiv|s2)\./, '');
    return { routeType: m[1], urlslug };
}

// Coarse structural FORM of a stored slug/id for distribution buckets:
// everything up to the last '--' (the prefix structure), or a shape tag if
// there is no separator. Lets us see whether the fallback uniquely saves the
// category-tail arxiv--cs--<id> papers vs. plain arxiv--<id> / bare ids.
function formKey(s) {
    if (!s) return '<empty>';
    const i = s.lastIndexOf('--');
    if (i < 0) return /^\d{4}\.\d{4,5}$/.test(s) ? '<bare-arxiv-id>'
        : /^[0-9a-f]{32,40}$/.test(s) ? '<bare-content-hash>' : '<no-sep>';
    return `${s.slice(0, i)}--<id>`;
}

// Core classifier — pure, unit-testable on hand-built rows (no R2 needed).
// row = { id, slug, type }. Returns { cls, storedShard, candidates }.
export function classifyEntity(row) {
    const id = (row.id || '').toLowerCase();
    const slug = (row.slug || '').toLowerCase();
    const type = row.type || '';
    // Packer placement: computeMetaShardSlot(e.slug || e.id) = xxhash64Mod(...).
    const storedShard = xxhash64Mod(slug || id, META_SHARD_COUNT);

    const url = urlSlugForEntity(row.id || '', type);
    if (!url) return { cls: 'unroutable', storedShard, candidates: [], reason: 'no-entity-url' };

    const normalized = normalizeUrlSlug(url.urlslug);
    const candidates = (type === 'paper' ? generatePaperCandidates(normalized) : [normalized])
        .filter(Boolean);
    if (candidates.length === 0) candidates.push(normalized);

    // identity-match: a candidate equals the stored slug or id (the resolver's
    // WHERE slug=c OR id=c). Required for BOTH primary and fallback hits.
    const idMatch = (c) => c === slug || c === id;

    // PRIMARY: candidate hashes to its OWN stored shard AND identity-matches.
    for (const c of candidates) {
        if (xxhash64Mod(c, META_SHARD_COUNT) === storedShard && idMatch(c)) {
            return { cls: 'primary-resolvable', storedShard, candidates };
        }
    }

    // FALLBACK: storedShard within +/-2 of xxhash64Mod(candidates[0]) AND some
    // candidate identity-matches (so the fallback's WHERE matches on that shard).
    const primaryIdx = xxhash64Mod(candidates[0], META_SHARD_COUNT);
    let withinRadius = false;
    for (let off = 1; off <= FALLBACK_RADIUS && !withinRadius; off++) {
        for (const delta of [off, -off]) {
            const adj = ((primaryIdx + delta) % META_SHARD_COUNT + META_SHARD_COUNT) % META_SHARD_COUNT;
            if (adj === storedShard) { withinRadius = true; break; }
        }
    }
    if (withinRadius && candidates.some(idMatch)) {
        return { cls: 'fallback-only', storedShard, candidates };
    }

    return { cls: 'unroutable', storedShard, candidates };
}

function listMetaShards() {
    if (!fs.existsSync(DATA_DIR)) throw new Error(`DATA_DIR missing: ${DATA_DIR}`);
    const files = fs.readdirSync(DATA_DIR)
        .filter(f => /^meta-\d+\.db$/.test(f))
        .map(f => path.join(DATA_DIR, f));
    if (files.length === 0) throw new Error(`No meta-NN.db found in ${DATA_DIR}`);
    return files.sort();
}

function bump(map, key) { map.set(key, (map.get(key) || 0) + 1); }

function probe() {
    const shards = listMetaShards();
    console.log(`[V27.98] Scanning ${shards.length} meta-NN.db shards in ${DATA_DIR} (META_SHARD_COUNT=${META_SHARD_COUNT})`);

    let total = 0;
    const clsCount = { 'primary-resolvable': 0, 'fallback-only': 0, 'unroutable': 0 };
    const byType = new Map();        // type -> { primary, fallback, unroutable }
    const fbForms = new Map();       // fallback-only stored-slug form -> count
    const unForms = new Map();       // unroutable stored-slug form -> count
    const fbSamples = [];
    const unSamples = [];

    for (const file of shards) {
        const db = new Database(file, { readonly: true });
        // Stream (P1): iterate keeps memory O(buckets+samples), not O(rows).
        const stmt = db.prepare('SELECT id, slug, type FROM entities');
        for (const row of stmt.iterate()) {
            total++;
            const { cls, storedShard, candidates } = classifyEntity(row);
            clsCount[cls]++;
            const t = row.type || '<null>';
            if (!byType.has(t)) byType.set(t, { 'primary-resolvable': 0, 'fallback-only': 0, 'unroutable': 0 });
            byType.get(t)[cls]++;
            const forms = cls === 'fallback-only' ? fbForms : cls === 'unroutable' ? unForms : null;
            const samples = cls === 'fallback-only' ? fbSamples : cls === 'unroutable' ? unSamples : null;
            if (forms) {
                bump(forms, formKey((row.slug || row.id || '').toLowerCase()));
                if (samples.length < SAMPLE_N)
                    samples.push({ id: row.id, slug: row.slug, type: row.type, storedShard, candidates });
            }
        }
        db.close();
    }
    report(total, clsCount, byType, fbForms, unForms, fbSamples, unSamples);
}

function pct(n, d) { return d ? (n / d * 100).toFixed(2) : '0.00'; }

function report(total, clsCount, byType, fbForms, unForms, fbSamples, unSamples) {
    console.log('\n========== V27.98 FALLBACK HIT-RATE RESULT ==========');
    console.log(`entities scanned     : ${total}`);
    console.log(`primary-resolvable   : ${clsCount['primary-resolvable']} (${pct(clsCount['primary-resolvable'], total)}%)`);
    console.log(`fallback-only        : ${clsCount['fallback-only']} (${pct(clsCount['fallback-only'], total)}%)  <- LOST if +/-2 dropped`);
    console.log(`unroutable           : ${clsCount['unroutable']} (${pct(clsCount['unroutable'], total)}%)  (pre-existing gap, not caused by drop)`);

    console.log('\n-- breakdown by type (type: primary / fallback-only / unroutable) --');
    const sumOf = (c) => c['primary-resolvable'] + c['fallback-only'] + c['unroutable'];
    [...byType.entries()].sort((a, b) => sumOf(b[1]) - sumOf(a[1])).forEach(([t, c]) => {
        console.log(`  ${String(t).padEnd(12)} ${String(sumOf(c)).padStart(9)} : ` +
            `${String(c['primary-resolvable']).padStart(9)} / ` +
            `${String(c['fallback-only']).padStart(7)} / ${String(c['unroutable']).padStart(9)}`);
    });

    const dump = (title, m) => {
        console.log(`\n-- ${title} (stored-slug form -> count, top 25) --`);
        const entries = [...m.entries()].sort((a, b) => b[1] - a[1]);
        if (entries.length === 0) { console.log('  (none)'); return; }
        entries.slice(0, 25).forEach(([k, v]) => console.log(`  ${String(v).padStart(9)}  ${k}`));
    };
    dump('FALLBACK-ONLY stored-slug form distribution', fbForms);
    dump('UNROUTABLE stored-slug form distribution', unForms);

    const sample = (title, arr) => {
        console.log(`\n-- ${title} (up to ${SAMPLE_N}) --`);
        if (arr.length === 0) { console.log('  (none)'); return; }
        arr.forEach(s => console.log(
            `  type=${s.type} shard=${s.storedShard}\n    id=${s.id}\n    slug=${s.slug}\n    candidates=[${s.candidates.join(', ')}]`));
    };
    sample('FALLBACK-ONLY samples', fbSamples);
    sample('UNROUTABLE samples', unSamples);

    console.log('\n========== VERDICT ==========');
    const fb = clsCount['fallback-only'];
    if (total === 0) {
        console.log('INCONCLUSIVE: zero entities found. Check shard set / table.');
    } else if (fb === 0) {
        console.log('SAFE-TO-DROP: the +/-2 fallback uniquely resolves 0 entities.');
        console.log('Per-candidate sharding already covers every routable entity ->');
        console.log('removing the fallback loses nothing (and kills 4 cold R2 opens on dead URLs).');
    } else {
        console.log(`CAUTION: the +/-2 fallback uniquely resolves ${fb} (${pct(fb, total)}%) entities.`);
        console.log('Inspect the FALLBACK-ONLY form distribution above. If it is the');
        console.log('category-tail arxiv--cs--<id> papers, FIX their candidate generation');
        console.log('(generatePaperCandidates) BEFORE dropping the fallback so the links survive.');
    }
    console.log('=============================');
}

// Entry guard: auto-run only when invoked as the main script, so the classifier
// can be imported by a sanity test without triggering the R2-dependent scan.
if (process.argv[1] && process.argv[1].endsWith('probe-fallback-hitrate.js')) {
    try { probe(); }
    catch (e) { console.error('[V27.98] FATAL:', e.message); process.exit(1); }
}
