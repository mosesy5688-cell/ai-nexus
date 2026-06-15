// tests/unit/citation-integrity.test.ts
//
// P3-EVIDENCE-1 Citation Integrity. The producer (umid-generator.normalizeCitation)
// must NEVER fabricate provenance: title is MANDATORY + genuine (never an id/slug/
// hash/placeholder); author/year/url are optional and OMITTED (never empty-shelled,
// never "Unknown", never current/bake-year, never internal-route url) when absent;
// a Semantic-Scholar object author-array ([{authorId,name},...]) must NOT coerce to
// "[object Object]". The bake canary (verify-canaries.verifyCitationIntegrity)
// independently re-scans every meta-NN.db shard and hard-fails on any violation.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
// @ts-ignore - JS ESM producer (no .d.ts); tested for its runtime contract.
import { normalizeCitation, generateCitation } from '../../scripts/factory/lib/umid-generator.js';
// @ts-ignore - JS ESM canary.
import { verifyCitationIntegrity } from '../../scripts/factory/lib/verify-canaries.js';
// @ts-ignore - projection boundary (test #17): null citation passes through unchanged.
import { sanitizeCitation } from '../../src/utils/text-sanitizer.js';

const base = { id: 'arxiv-paper--2401--attention', slug: 'attention-is-all-you-need', type: 'paper' };

describe('P3-EVIDENCE-1 normalizeCitation - author resolution (1-6)', () => {
    it('1 string author value -> author component present', () => {
        const c = normalizeCitation({ ...base, name: 'Attention Is All You Need', author: 'Vaswani, Ashish' });
        expect(c).toContain('author={Vaswani, Ashish}');
    });
    it('2 string author array -> joined with " and "', () => {
        const c = normalizeCitation({ ...base, name: 'Attention', author: ['Vaswani', 'Shazeer'] });
        expect(c).toContain('author={Vaswani and Shazeer}');
    });
    it('3 object array with valid .name -> names extracted', () => {
        const c = normalizeCitation({ ...base, name: 'Attention',
            author: [{ authorId: '1', name: 'A. Vaswani' }, { authorId: '2', name: 'N. Shazeer' }] });
        expect(c).toContain('author={A. Vaswani and N. Shazeer}');
        expect(c).not.toContain('[object Object]');
    });
    it('4 mixed string/object array -> all usable members kept', () => {
        const c = normalizeCitation({ ...base, name: 'Attention',
            author: ['Vaswani', { name: 'Shazeer' }] });
        expect(c).toContain('author={Vaswani and Shazeer}');
    });
    it('5 object without .name -> member dropped, author OMITTED (no shell)', () => {
        const c = normalizeCitation({ ...base, name: 'Attention', author: [{ authorId: '1' }] });
        expect(c).not.toContain('author=');
        expect(c).not.toContain('[object Object]');
    });
    it('6 null/empty author -> author OMITTED (not "Unknown", not shell)', () => {
        const c1 = normalizeCitation({ ...base, name: 'Attention', author: null });
        const c2 = normalizeCitation({ ...base, name: 'Attention', author: '   ' });
        const c3 = normalizeCitation({ ...base, name: 'Attention', author: [] });
        for (const c of [c1, c2, c3]) {
            expect(c).not.toContain('author=');
            expect(c).not.toContain('Unknown');
        }
    });
});

describe('P3-EVIDENCE-1 normalizeCitation - title / null contract (7-8)', () => {
    it('7 title absent + ID present -> citation null (no id-as-title)', () => {
        expect(normalizeCitation({ id: 'arxiv-paper--x', slug: 'x', type: 'paper' })).toBeNull();
        expect(normalizeCitation({ id: 'gh-tool--y', name: '   ' })).toBeNull();
    });
    it('8 title present + author absent -> valid citation WITHOUT author component', () => {
        const c = normalizeCitation({ ...base, name: 'Attention Is All You Need' });
        expect(c).toContain('title={Attention Is All You Need}');
        expect(c).not.toContain('author=');
        expect(c).toMatch(/^@misc\{/);
    });
});

describe('P3-EVIDENCE-1 normalizeCitation - year / url optionals (9-11)', () => {
    it('9 year absent -> no year component (never current/bake year)', () => {
        const c = normalizeCitation({ ...base, name: 'Attention' });
        expect(c).not.toContain('year=');
    });
    it('10 valid source year -> exact published_year retained', () => {
        const c = normalizeCitation({ ...base, name: 'Attention', published_year: 2017 });
        expect(c).toContain('year={2017}');
    });
    it('10b year from meta_json.published_date (structured source) retained', () => {
        const c = normalizeCitation({ ...base, name: 'Attention', meta_json: { published_date: '2017-06-12' } });
        expect(c).toContain('year={2017}');
    });
    it('11 source URL absent -> no url component (no internal route residue)', () => {
        const c = normalizeCitation({ ...base, name: 'Attention' });
        expect(c).not.toContain('url=');
        const c2 = normalizeCitation({ ...base, name: 'Attention', source_url: 'https://free2aitools.com/papers/x' });
        expect(c2).not.toContain('url=');
    });
    it('11b real external source URL retained', () => {
        const c = normalizeCitation({ ...base, name: 'Attention', source_url: 'https://arxiv.org/abs/1706.03762' });
        expect(c).toContain('url={https://arxiv.org/abs/1706.03762}');
    });
});

describe('P3-EVIDENCE-1 normalizeCitation - golden + anti-fabrication (12-16)', () => {
    it('12 normal complete citation golden', () => {
        const c = normalizeCitation({ ...base, name: 'Attention Is All You Need',
            author: [{ name: 'A. Vaswani' }], published_year: 2017,
            source_url: 'https://arxiv.org/abs/1706.03762' });
        expect(c).toBe('@misc{arxiv_paper__2401__attention,title={Attention Is All You Need},'
            + 'author={A. Vaswani},year={2017},url={https://arxiv.org/abs/1706.03762},'
            + 'note={Indexed by Free2AITools}}');
    });
    it('13 output never contains "[object Object]" for object author array', () => {
        const c = normalizeCitation({ ...base, name: 'Attention',
            author: [{ authorId: '1', name: 'A' }, { authorId: '2', name: 'B' }] });
        expect(c).not.toContain('[object Object]');
    });
    it('14 no ID/hash/slug-as-title (rejects id, slug, hash, placeholder echoes)', () => {
        // name echoing the id -> rejected -> null
        expect(normalizeCitation({ ...base, name: base.id })).toBeNull();
        expect(normalizeCitation({ ...base, name: base.slug })).toBeNull();
        expect(normalizeCitation({ id: 'x', name: 'a1b2c3d4e5f60718' })).toBeNull(); // hash-like
        expect(normalizeCitation({ id: 'x', name: 'Unknown' })).toBeNull();
    });
    it('15 no current/bake-year substitution when year is absent', () => {
        const now = String(new Date().getFullYear());
        const c = normalizeCitation({ ...base, name: 'Attention' });
        expect(c).not.toContain(`year={${now}}`);
        expect(c).not.toContain('year=');
    });
    it('16 no empty-field shells anywhere', () => {
        const c = normalizeCitation({ ...base, name: 'Attention', author: [{ authorId: '1' }] });
        for (const shell of ['title={}', 'author={}', 'year={}', 'url={}']) {
            expect(c).not.toContain(shell);
        }
    });
});

describe('P3-EVIDENCE-1 projection boundary + invariants (17-18)', () => {
    it('17 entity-projection accepts citation null (passthrough, no fabrication)', () => {
        // sanitizeCitation is the projection's citation gate (entity-projection.ts:145).
        // It must pass a producer null through as null WITHOUT modifying entity-projection.
        expect(sanitizeCitation(null)).toBeNull();
        expect(sanitizeCitation(undefined)).toBeNull();
        // and a genuine citation survives sanitization intact.
        const c = normalizeCitation({ ...base, name: 'Attention', published_year: 2017 });
        expect(sanitizeCitation(c)).toContain('title={Attention}');
    });
    it('18 generateCitation delegates to normalizeCitation (identity-preserving alias)', () => {
        const e = { ...base, name: 'Attention', author: [{ name: 'A. Vaswani' }], published_year: 2017 };
        expect(generateCitation(e)).toBe(normalizeCitation(e));
        // non-citation fields on the entity are untouched by the pure function.
        const snapshot = JSON.stringify(e);
        normalizeCitation(e);
        expect(JSON.stringify(e)).toBe(snapshot);
    });
});

describe('P3-EVIDENCE-1 bake canary - verifyCitationIntegrity execution proof', () => {
    let tmp: string;
    let dir: string;
    const results: { label: string; pass: boolean; detail: string }[] = [];
    const check = (label: string, pass: boolean, detail = '') => results.push({ label, pass, detail });

    function makeShard(name: string, rows: any[]) {
        const db = new Database(path.join(dir, name));
        db.exec('CREATE TABLE entities (id TEXT PRIMARY KEY, slug TEXT, citation TEXT, published_year INTEGER)');
        const ins = db.prepare('INSERT INTO entities (id, slug, citation, published_year) VALUES (?,?,?,?)');
        for (const r of rows) ins.run(r.id, r.slug, r.citation, r.published_year ?? null);
        db.close();
    }

    beforeAll(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'citation-canary-'));
        dir = path.join(tmp, 'data');
        fs.mkdirSync(dir, { recursive: true });
        // Clean population across TWO shards proves multi-shard scan (not only meta-00).
        makeShard('meta-00.db', [
            { id: 'p1', slug: 'attention', citation: normalizeCitation({ id: 'p1', name: 'Attention', published_year: 2017 }), published_year: 2017 },
            { id: 'p2', slug: 'gpt', citation: null }, // null citation is valid
        ]);
        makeShard('meta-01.db', [
            { id: 'p3', slug: 'bert', citation: normalizeCitation({ id: 'p3', name: 'BERT', author: [{ name: 'J. Devlin' }] }) },
        ]);
    });
    afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

    it('scans every meta-NN.db shard and PASSES on a clean corpus (execution proof)', () => {
        results.length = 0;
        verifyCitationIntegrity(dir, check);
        const scan = results.find(r => r.label === 'Citation: shards scanned')!;
        expect(scan.pass).toBe(true);
        expect(scan.detail).toContain('2 shards');
        expect(scan.detail).toContain('3 rows');
        expect(results.every(r => r.pass)).toBe(true);
    });

    it('HARD-FAILS on [object Object], id-as-title, shells, year-conflict (fail-loud)', () => {
        const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'citation-bad-'));
        const d2 = path.join(tmp2, 'data');
        fs.mkdirSync(d2, { recursive: true });
        const db = new Database(path.join(d2, 'meta-00.db'));
        db.exec('CREATE TABLE entities (id TEXT PRIMARY KEY, slug TEXT, citation TEXT, published_year INTEGER)');
        const ins = db.prepare('INSERT INTO entities (id, slug, citation, published_year) VALUES (?,?,?,?)');
        ins.run('b1', 's1', '@misc{b1,title={T},author={[object Object]},note={x}}', null);
        ins.run('b2', 's2', '@misc{b2,title={b2},note={x}}', null);              // id-as-title
        ins.run('b3', 's3', '@misc{b3,title={},author={},note={x}}', null);      // shells + no title-content
        ins.run('b4', 's4', '@misc{b4,title={Real},year={2020},note={x}}', 2017); // year conflict
        db.close();
        const r: { label: string; pass: boolean }[] = [];
        verifyCitationIntegrity(d2, (label: string, pass: boolean) => r.push({ label, pass }));
        const fail = (lbl: string) => r.find(x => x.label === lbl)!.pass;
        expect(fail('Citation: no [object Object]')).toBe(false);
        expect(fail('Citation: no id/hash-as-title')).toBe(false);
        expect(fail('Citation: no empty shells')).toBe(false);
        expect(fail('Citation: year vs source')).toBe(false);
        fs.rmSync(tmp2, { recursive: true, force: true });
    });
});
