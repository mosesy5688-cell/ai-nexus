import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import Database from 'better-sqlite3';
// @ts-ignore — JS factory module, no types.
import { generateSitemap } from '../../scripts/factory/lib/sitemap-generator.js';

// C3 REGISTRY — which sitemap URLs legitimately carry NO <lastmod>, and why.
//
// Measured on the live sitemap set (14 children, 2026-09-13): 617,574 <loc> and
// 617,557 <lastmod>, i.e. 17 URLs with no <lastmod>. Enumerated, those 17 were
// the 16 hand-authored static hub/landing routes below plus the single bogus
// /knowledge/stats-json-zst row that C1 removes. Zero entity pages were missing
// one. After C1 the registered count is 16, and it is HONEST: STATIC_PAGES in
// sitemap-generator.js carries no timestamp field at all, because a hand-authored
// Astro route has no content-modification time in the generator's inputs. The
// only value available would be the run's own clock — a fabricated re-stamp.
//
// So the assertion is deliberately two-sided: the omission set must be EXACTLY
// these 16, and no <lastmod> value may appear that was not supplied by an input
// row. Adding a static page, or filling omissions with a generated timestamp,
// both fail here.
//
// TWO DIFFERENT CLAIMS, TWO DIFFERENT CODE PATHS — do not blur them. The "16"
// lock below is the STATIC_PAGES claim, and it is driven through the legacy
// array branch (sitemap-generator.js:164), where the knowledge block cannot run.
// The knowledge block lives at :149-159, inside the `.db` branch guarded by
// :114 `typeof source === 'string' && source.endsWith('.db')`, so an array
// fixture is structurally blind to it. The second describe drives the `.db`
// path with a real meta-knowledge.db so the knowledge half is actually
// exercised: rows whose `published_at` is '' — the value meta-anchors.js binds
// when a payload has no date — must land in the omission set, and the total is
// then 16 + one per such row, NOT 16.

const STATIC_PAGES_WITHOUT_LASTMOD = [
    '/', '/about', '/automation-workflow', '/datasets', '/explore',
    '/infrastructure-ops', '/knowledge', '/knowledge-retrieval', '/methodology',
    '/models', '/papers', '/ranking', '/search', '/text-generation', '/tools',
    '/vision-multimedia',
];
const REGISTERED_OMISSION_COUNT = 16;
const BASE = 'https://free2aitools.com';

const SUPPLIED = ['2026-01-15T00:00:00Z', '2026-02-15T00:00:00Z', '2026-03-15T00:00:00Z'];

let outDir: string;
let xml = '';

/** Every <url> block, split into its loc and whether it has a <lastmod>. */
function blocks(x: string) {
    return [...x.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => ({
        loc: /<loc>([^<]*)<\/loc>/.exec(m[1])![1],
        lastmod: (/<lastmod>([^<]*)<\/lastmod>/.exec(m[1]) || [, null])[1] as string | null,
    }));
}

async function build(entities: any[], dir: string) {
    await generateSitemap(entities, dir);
    return zlib.gunzipSync(fs.readFileSync(path.join(dir, 'sitemaps', 'sitemap-1.xml.gz'))).toString('utf8');
}

beforeAll(async () => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-lm-'));
    xml = await build(SUPPLIED.map((lm, i) => ({
        id: `m${i}`, slug: `owner/model-${i}`, type: 'model', fni_score: 50, last_modified: lm,
    })), outDir);
});

afterAll(() => { fs.rmSync(outDir, { recursive: true, force: true }); });

describe('C3 — the registered <lastmod> omission set (STATIC_PAGES claim, array path)', () => {
    it('is exactly the 16 static hub pages', () => {
        const missing = blocks(xml).filter((b) => b.lastmod === null).map((b) => b.loc).sort();
        const expected = STATIC_PAGES_WITHOUT_LASTMOD.map((p) => (p === '/' ? BASE + '/' : BASE + p)).sort();
        expect(missing).toEqual(expected);
    });

    it('has the registered count', () => {
        expect(blocks(xml).filter((b) => b.lastmod === null)).toHaveLength(REGISTERED_OMISSION_COUNT);
    });

    it('contains no entity page', () => {
        const missing = blocks(xml).filter((b) => b.lastmod === null).map((b) => b.loc);
        expect(missing.filter((l) => /\/(model|tool|dataset|paper)\//.test(l))).toEqual([]);
    });

    it('every entity URL that supplied a time carries it', () => {
        const present = blocks(xml).filter((b) => b.lastmod !== null);
        expect(present).toHaveLength(SUPPLIED.length);
        expect(present.map((b) => b.lastmod).sort()).toEqual([...SUPPLIED].sort());
    });
});

describe('C3 — omission is never backfilled with a derived value', () => {
    it('no emitted <lastmod> value came from anywhere but an input row', () => {
        const emitted = new Set(blocks(xml).map((b) => b.lastmod).filter(Boolean) as string[]);
        for (const v of emitted) expect(SUPPLIED).toContain(v);
    });

    it('no <lastmod> is dated near the run clock', () => {
        // A generation re-stamp would land within a day of now; supplied values do not.
        const dayMs = 24 * 60 * 60 * 1000;
        for (const b of blocks(xml)) {
            if (!b.lastmod) continue;
            expect(Math.abs(Date.now() - Date.parse(b.lastmod))).toBeGreaterThan(dayMs);
        }
    });

    it('an entity with no usable time is OMITTED, not stamped', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-lm2-'));
        try {
            const x = await build([
                { id: 'a', slug: 'owner/empty', type: 'model', fni_score: 50, last_modified: '' },
                { id: 'b', slug: 'owner/garbage', type: 'model', fni_score: 50, last_modified: 'not-a-date' },
            ], dir);
            const bs = blocks(x).filter((b) => /owner--(empty|garbage)/.test(b.loc));
            expect(bs).toHaveLength(2);
            for (const b of bs) expect(b.lastmod).toBeNull();
            // and the tag is absent entirely, not present-but-empty
            expect(x).not.toContain('<lastmod></lastmod>');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

// The knowledge half. Driven through the `.db` branch so sitemap-generator.js
// :149-159 actually runs — the array fixture above can never reach it.
describe('C3 — knowledge rows with no date land in the omission set (.db path)', () => {
    let dbXml = '';
    let dbDir = '';
    const DATED = 4;
    const UNDATED = 6;

    beforeAll(async () => {
        dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-lm-db-'));
        const dataDir = path.join(dbDir, 'data');
        fs.mkdirSync(dataDir, { recursive: true });

        const shard = path.join(dataDir, 'meta-00.db');
        const edb = new Database(shard);
        edb.exec(`CREATE TABLE entities (id TEXT, slug TEXT, type TEXT, fni_score REAL,
            last_modified TEXT, readme_html TEXT, summary TEXT)`);
        edb.prepare('INSERT INTO entities VALUES (?,?,?,?,?,?,?)')
            .run('m1', 'owner/model-1', 'model', 90, SUPPLIED[0], '', '');
        edb.close();

        // Mirrors meta-anchors.js ANCHOR_SCHEMA and its binding: published_at is ''
        // (not NULL) whenever the payload carried no published_at/date.
        const kdb = new Database(path.join(dataDir, 'meta-knowledge.db'));
        kdb.exec(`CREATE TABLE articles (id TEXT PRIMARY KEY, umid TEXT UNIQUE, title TEXT,
            subtitle TEXT, summary TEXT, category TEXT, tags TEXT, author TEXT,
            published_at TEXT, updated_at TEXT, slug TEXT, word_count INTEGER, status TEXT,
            canonical_url TEXT, citation TEXT, content TEXT, highlights_json TEXT)`);
        const ins = kdb.prepare('INSERT INTO articles VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
        for (let i = 0; i < DATED; i++) {
            ins.run(`d${i}`, `ud${i}`, `D${i}`, '', '', 'knowledge', '', 'f2a',
                SUPPLIED[1], '', `dated-${i}`, 0, 'published', '', '', '', '');
        }
        for (let i = 0; i < UNDATED; i++) {
            ins.run(`u${i}`, `uu${i}`, `U${i}`, '', '', 'knowledge', '', 'f2a',
                '', '', `undated-${i}`, 0, 'published', '', '', '', '');
        }
        kdb.close();

        await generateSitemap(shard, path.join(dbDir, 'out'));
        dbXml = zlib.gunzipSync(
            fs.readFileSync(path.join(dbDir, 'out', 'sitemaps', 'sitemap-1.xml.gz'))
        ).toString('utf8');
    });

    afterAll(() => { fs.rmSync(dbDir, { recursive: true, force: true }); });

    it('the knowledge block actually ran (guards against a blind fixture)', () => {
        const knowledge = blocks(dbXml).filter((b) => /\/knowledge\//.test(b.loc));
        expect(knowledge).toHaveLength(DATED + UNDATED);
    });

    it('every undated knowledge row is in the omission set', () => {
        const missing = blocks(dbXml).filter((b) => b.lastmod === null).map((b) => b.loc);
        for (let i = 0; i < UNDATED; i++) {
            expect(missing).toContain(`${BASE}/knowledge/undated-${i}`);
        }
    });

    it('dated knowledge rows carry the date their row supplied, not a run stamp', () => {
        for (let i = 0; i < DATED; i++) {
            const b = blocks(dbXml).find((x) => x.loc === `${BASE}/knowledge/dated-${i}`)!;
            expect(b.lastmod).toBe(SUPPLIED[1]);
        }
    });

    it('the omission total on this path is 16 + the undated rows, not 16', () => {
        const missing = blocks(dbXml).filter((b) => b.lastmod === null);
        expect(missing).toHaveLength(REGISTERED_OMISSION_COUNT + UNDATED);
        expect(missing.length).not.toBe(REGISTERED_OMISSION_COUNT);
    });
});
