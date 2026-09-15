import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import Database from 'better-sqlite3';

// C1 end-to-end: the knowledge cache directory -> meta-knowledge.db -> sitemap.
// Production served /knowledge/stats-json-zst (HTTP 404) as the ONLY member of
// the knowledge block, because the generator's own stats blob was indexed as a
// published article. This drives the real buildKnowledgeDb() over a cache tree
// shaped exactly like production's, then the real generateSitemap() over the DB
// it produced, and asserts the unresolvable slug never reaches the XML while a
// genuine article still does.
//
// CACHE_DIR / OUTPUT_DIR are read at module-load time in meta-anchors.js, so
// they are stubbed before the dynamic import below.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kn-anchor-'));
const cacheDir = path.join(tmp, 'cache');
const dataDir = path.join(tmp, 'data');
const knowledgeDir = path.join(cacheDir, 'knowledge');
fs.mkdirSync(knowledgeDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
process.env.CACHE_DIR = cacheDir;
process.env.OUTPUT_DIR = dataDir;

const write = (name: string, obj: unknown) =>
    fs.writeFileSync(path.join(knowledgeDir, name), JSON.stringify(obj));

let rows: Array<{ id: string; slug: string; published_at: string }> = [];
let childXml = '';
let locs: string[] = [];

beforeAll(async () => {
    // Exactly what knowledge-data-generator.js + smart-writer.js leave behind,
    // under their real production filenames. Bodies are plain JSON: autoDecompress
    // sniffs content, not the extension, so no zstd toolchain is needed here and
    // the `.json.zst` names still exercise the id derivation that produced
    // `stats-json-zst`.
    write('index.json.zst', [{ slug: 'lora', title: 'LoRA', category: 'techniques' }]);
    write('stats.json.zst', { _v: '16.2', _ts: '2026-09-12T10:00:00Z', total_articles: 1 });
    write('stats.json.zst.meta.json', { checksum: 'abc' });
    write('index.v-1.json.zst', [{ slug: 'lora', title: 'LoRA' }]);
    // ...plus one genuine article payload, which MUST survive the gate.
    write('lora.json.zst', {
        title: 'LoRA', summary: 'Low-Rank Adaptation', category: 'techniques',
        published_at: '2026-08-01T00:00:00Z',
    });

    // @ts-ignore — JS factory module, no types.
    const { buildKnowledgeDb } = await import('../../scripts/factory/lib/meta-anchors.js');
    await buildKnowledgeDb();

    const kdb = new Database(path.join(dataDir, 'meta-knowledge.db'), { readonly: true });
    rows = kdb.prepare('SELECT id, slug, published_at FROM articles WHERE status = ?').all('published') as typeof rows;
    kdb.close();

    // One entity shard so generateSitemap takes its VFS path, as in production.
    const shard = path.join(dataDir, 'meta-00.db');
    const edb = new Database(shard);
    edb.exec(`CREATE TABLE entities (id TEXT, slug TEXT, type TEXT, fni_score REAL,
        last_modified TEXT, readme_html TEXT, summary TEXT)`);
    edb.prepare('INSERT INTO entities VALUES (?,?,?,?,?,?,?)')
        .run('m1', 'owner/model-1', 'model', 90, '2026-08-02T00:00:00Z', '', '');
    edb.close();

    // @ts-ignore — JS factory module, no types.
    const { generateSitemap } = await import('../../scripts/factory/lib/sitemap-generator.js');
    const outDir = path.join(tmp, 'out');
    await generateSitemap(shard, outDir);
    childXml = zlib.gunzipSync(fs.readFileSync(path.join(outDir, 'sitemaps', 'sitemap-1.xml.gz'))).toString('utf8');
    locs = [...childXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
});

afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('C1 — the unresolvable slug never becomes a published row', () => {
    it('the production offender stats-json-zst is not in meta-knowledge.db', () => {
        expect(rows.map((r) => r.slug)).not.toContain('stats-json-zst');
        expect(rows.map((r) => r.slug)).not.toContain('stats');
        expect(rows.map((r) => r.id)).not.toContain('stats.json.zst');
    });

    it('the catalog index and its version rotation are not rows either', () => {
        for (const slug of rows.map((r) => r.slug)) {
            expect(slug.startsWith('index')).toBe(false);
        }
    });

    it('the genuine article IS a row, with the slug its filename implies', () => {
        expect(rows.map((r) => r.slug)).toContain('lora');
        expect(rows.find((r) => r.slug === 'lora')!.published_at).toBe('2026-08-01T00:00:00Z');
    });

    it('exactly one row survives the cache tree — the article', () => {
        expect(rows).toHaveLength(1);
    });
});

describe('C1 — the sitemap knowledge block is intact, not dropped', () => {
    it('no /knowledge/stats-json-zst is emitted', () => {
        expect(childXml).not.toContain('/knowledge/stats-json-zst');
        expect(locs.filter((l) => /\/knowledge\/stats/.test(l))).toEqual([]);
    });

    it('the block still emits real articles — the knowledge query was NOT removed', () => {
        expect(locs).toContain('https://free2aitools.com/knowledge/lora');
    });

    it('the /knowledge hub static page is still emitted', () => {
        expect(locs).toContain('https://free2aitools.com/knowledge');
    });

    it('the article carries the lastmod its row supplies', () => {
        const block = childXml.match(/<loc>https:\/\/free2aitools\.com\/knowledge\/lora<\/loc>[\s\S]*?<\/url>/)![0];
        expect(block).toContain('<lastmod>2026-08-01T00:00:00Z</lastmod>');
    });

    it('the entity shard URL is unaffected', () => {
        expect(locs.some((l) => l.includes('owner--model-1'))).toBe(true);
    });
});
