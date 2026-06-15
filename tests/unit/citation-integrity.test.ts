// tests/unit/citation-integrity.test.ts
// P3-EVIDENCE-1 Citation Integrity. The producer (umid-generator.normalizeCitation)
// must NEVER fabricate provenance: title MANDATORY + genuine (never id/slug/hash/
// placeholder); author/year/url OMITTED when absent (never empty-shelled, "Unknown",
// current/bake-year, or internal-route url); object author-arrays must NOT coerce to
// "[object Object]". The bake canary (verifyCitationIntegrity) re-scans every meta-
// NN.db shard, fail-CLOSES on zero/incomplete coverage, and hard-fails any violation.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
// @ts-ignore - JS ESM producer (no .d.ts); tested for its runtime contract.
import { normalizeCitation, generateCitation } from '../../scripts/factory/lib/umid-generator.js';
// @ts-ignore - JS ESM canary.
import { verifyCitationIntegrity } from '../../scripts/factory/lib/verify-canaries.js';
// @ts-ignore - single-source shard count the canary fail-closes against (= packer's).
import { META_SHARD_COUNT } from '../../src/constants/shard-constants.js';
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

describe('P3-EVIDENCE-1 bake canary - verifyCitationIntegrity fail-closed coverage', () => {
    const tmpRoots: string[] = [];
    function newDir(prefix: string): string {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
        tmpRoots.push(root);
        const dir = path.join(root, 'data');
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    }
    const shardName = (i: number) => `meta-${String(i).padStart(2, '0')}.db`;
    // One meta-NN.db with a valid entities+citation schema; rows optional.
    function makeShard(dir: string, i: number, rows: any[] = [], withCitationCol = true) {
        const db = new Database(path.join(dir, shardName(i)));
        const cols = withCitationCol ? 'id TEXT PRIMARY KEY, slug TEXT, citation TEXT, published_year INTEGER' : 'id TEXT PRIMARY KEY, slug TEXT';
        db.exec(`CREATE TABLE entities (${cols})`);
        if (withCitationCol) {
            const ins = db.prepare('INSERT INTO entities (id, slug, citation, published_year) VALUES (?,?,?,?)');
            for (const r of rows) ins.run(r.id, r.slug, r.citation, r.published_year ?? null);
        }
        db.close();
    }
    // The COMPLETE expected shard set; populate(i) seeds rows into selected shards.
    function makeFullCorpus(dir: string, populate: (i: number) => any[] = () => []) {
        for (let i = 0; i < META_SHARD_COUNT; i++) makeShard(dir, i, populate(i));
    }
    function run(dir: string) {
        const results: { label: string; pass: boolean; detail: string }[] = [];
        verifyCitationIntegrity(dir, (label: string, pass: boolean, detail = '') => results.push({ label, pass, detail }));
        return results;
    }
    afterAll(() => { for (const r of tmpRoots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } } });

    it('A: zero discovered shards (empty dir) -> a check FAILS (no silent pass)', () => {
        const r = run(newDir('citation-empty-'));
        expect(r.length).toBeGreaterThan(0);
        expect(r.some(x => x.pass === false)).toBe(true);                 // canary fails
        expect(r.some(x => x.label === 'Citation: shards scanned' && x.pass)).toBe(false); // no green proof
    });

    it('B: zero scanned shards (files present, no citation col) -> FAIL', () => {
        const dir = newDir('citation-unscannable-');
        for (let i = 0; i < META_SHARD_COUNT; i++) makeShard(dir, i, [], false); // no citation col -> unscanned
        const scan = run(dir).find(x => x.label === 'Citation: shards scanned')!;
        expect(scan.pass).toBe(false);
        expect(scan.detail).toContain('scanned 0');
    });

    it('C: incomplete coverage (1 missing) -> FAIL and detail names the missing shard', () => {
        const dir = newDir('citation-incomplete-');
        makeFullCorpus(dir, i => (i === 0
            ? [{ id: 'p1', slug: 'attention', citation: normalizeCitation({ id: 'p1', name: 'Attention', published_year: 2017 }), published_year: 2017 }]
            : []));
        const missingName = shardName(META_SHARD_COUNT - 1);
        fs.rmSync(path.join(dir, missingName)); // discovered = expected-1 -> incomplete
        const r = run(dir);
        const cov = r.find(x => x.label === 'Citation: complete coverage')!;
        expect(cov.pass).toBe(false);
        expect(cov.detail).toContain(missingName);                       // MISSING id named
        expect(cov.detail).toContain(`expected ${META_SHARD_COUNT}`);
        expect(r.some(x => x.label === 'Citation: no [object Object]')).toBe(false); // content checks skipped
    });

    it('D: complete non-zero coverage, clean citations -> all checks PASS', () => {
        const dir = newDir('citation-clean-');
        // Real citations in two distinct shards (proves multi-shard scan); rest empty.
        makeFullCorpus(dir, i => {
            if (i === 0) return [
                { id: 'p1', slug: 'attention', citation: normalizeCitation({ id: 'p1', name: 'Attention', published_year: 2017 }), published_year: 2017 },
                { id: 'p2', slug: 'gpt', citation: null }, // null citation is contract-valid
            ];
            if (i === 5) return [{ id: 'p3', slug: 'bert', citation: normalizeCitation({ id: 'p3', name: 'BERT', author: [{ name: 'J. Devlin' }] }) }];
            return [];
        });
        const r = run(dir);
        const scan = r.find(x => x.label === 'Citation: shards scanned')!;
        expect(scan.pass).toBe(true);
        expect(scan.detail).toContain(`${META_SHARD_COUNT}/${META_SHARD_COUNT} shards`);
        expect(scan.detail).toContain('3 rows');
        expect(r.every(x => x.pass)).toBe(true);
        expect(r.some(x => x.label === 'Citation: no [object Object]' && x.pass)).toBe(true); // content checks ran
    });

    it('E: complete coverage + adversarial corrupt citations -> content checks FAIL', () => {
        const dir = newDir('citation-corrupt-');
        makeFullCorpus(dir, i => (i === 0 ? [
            { id: 'b1', slug: 's1', citation: '@misc{b1,title={T},author={[object Object]},note={x}}' },
            { id: 'b2', slug: 's2', citation: '@misc{b2,title={b2},note={x}}' },               // id-as-title
            { id: 'b3', slug: 's3', citation: '@misc{b3,title={},author={},note={x}}' },        // shells
            { id: 'b4', slug: 's4', citation: '@misc{b4,title={Real},year={2020},note={x}}', published_year: 2017 }, // year conflict
        ] : []));
        const r = run(dir);
        const fail = (lbl: string) => r.find(x => x.label === lbl)!.pass;
        expect(fail('Citation: no [object Object]')).toBe(false);
        expect(fail('Citation: no id/hash-as-title')).toBe(false);
        expect(fail('Citation: no empty shells')).toBe(false);
        expect(fail('Citation: year vs source')).toBe(false);
    });
});
