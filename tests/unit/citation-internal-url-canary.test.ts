// tests/unit/citation-internal-url-canary.test.ts
// P3-EVIDENCE-1 STAGE-B (Founder D-2026-0616-59) -- ABSOLUTE internal Free2AITools URL
// canary. The producer normalizeCitation already rejects ANY free2aitools.com url, but
// the bake canary's prior residue checks (relative-route /models/... + "by Free2AITools")
// did NOT catch an ABSOLUTE-domain url={https://free2aitools.com/...}. The 96/96-shard
// live baseline measured ~99.99% of served citations carrying exactly that absolute
// internal url, silently passing the canary -- a producer-vs-canary contract gap. These
// tests pin the new zero-tolerance gate ('Citation: no internal Free2AITools URL') and
// its pure predicate. Hermetic; no network/prod/AE.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
// @ts-ignore - JS ESM canary (no .d.ts); tested for its runtime contract.
import { citationHasInternalUrl, verifyCitationIntegrity } from '../../scripts/factory/lib/verify-canaries.js';
// @ts-ignore - single-source shard count the canary fail-closes against.
import { META_SHARD_COUNT } from '../../src/constants/shard-constants.js';

const cit = (url: string) => `@misc{x,title={Real Paper Title},author={A. Author},year={2020},url={${url}}}`;

describe('citationHasInternalUrl -- the 6 Founder-mandated cases', () => {
    it('absolute free2aitools.com url -> violation (fail)', () => {
        expect(citationHasInternalUrl(cit('https://free2aitools.com/models/x'))).toBe(true);
    });
    it('www subdomain -> violation', () => {
        expect(citationHasInternalUrl(cit('https://www.free2aitools.com/papers/x'))).toBe(true);
    });
    it('cdn subdomain -> violation', () => {
        expect(citationHasInternalUrl(cit('https://cdn.free2aitools.com/x'))).toBe(true);
    });
    it('http + UPPERCASE host -> violation (case-insensitive, http and https)', () => {
        expect(citationHasInternalUrl(cit('http://FREE2AITOOLS.COM/tools/x'))).toBe(true);
    });
    it('arxiv external url -> allowed (pass)', () => {
        expect(citationHasInternalUrl(cit('https://arxiv.org/abs/1234'))).toBe(false);
    });
    it('github external url -> allowed (pass)', () => {
        expect(citationHasInternalUrl(cit('https://github.com/org/repo'))).toBe(false);
    });
});

describe('citationHasInternalUrl -- edge cases (no false positive / no miss)', () => {
    it('huggingface external -> allowed', () => {
        expect(citationHasInternalUrl(cit('https://huggingface.co/meta/x'))).toBe(false);
    });
    it('deeper subdomain (a.b.free2aitools.com) -> violation', () => {
        expect(citationHasInternalUrl(cit('https://a.b.free2aitools.com/x'))).toBe(true);
    });
    it('bare host with no path -> violation', () => {
        expect(citationHasInternalUrl(cit('https://free2aitools.com'))).toBe(true);
    });
    it('look-alike domain (notfree2aitools.com) -> allowed (not our domain)', () => {
        expect(citationHasInternalUrl(cit('https://notfree2aitools.com/x'))).toBe(false);
    });
    it('suffix-attack (free2aitools.com.evil.com) -> allowed (host is evil.com)', () => {
        expect(citationHasInternalUrl(cit('https://free2aitools.com.evil.com/x'))).toBe(false);
    });
    it('domain ONLY in title/note, not the url field -> NO false positive', () => {
        const c = '@misc{x,title={About https://free2aitools.com today},'
            + 'note={see free2aitools.com},url={https://arxiv.org/abs/1}}';
        expect(citationHasInternalUrl(c)).toBe(false);
    });
    it('no url field at all -> pass', () => {
        expect(citationHasInternalUrl('@misc{x,title={Real},author={A}}')).toBe(false);
    });
    it('non-string input -> pass (never throws)', () => {
        expect(citationHasInternalUrl(null as unknown as string)).toBe(false);
        expect(citationHasInternalUrl(undefined as unknown as string)).toBe(false);
    });
});

// ---- full-corpus integration: the live canary gate must fire ----------------------
describe('verifyCitationIntegrity -- internal-URL gate end to end', () => {
    const tmpRoots: string[] = [];
    function newDir(prefix: string): string {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
        tmpRoots.push(root);
        const dir = path.join(root, 'data');
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    }
    function shardName(i: number) { return `meta-${String(i).padStart(2, '0')}.db`; }
    function makeShard(dir: string, i: number, rows: any[] = []) {
        const db = new Database(path.join(dir, shardName(i)));
        db.exec('CREATE TABLE entities (id TEXT PRIMARY KEY, slug TEXT, citation TEXT, published_year INTEGER)');
        const ins = db.prepare('INSERT INTO entities (id, slug, citation, published_year) VALUES (?,?,?,?)');
        for (const r of rows) ins.run(r.id, r.slug, r.citation, r.published_year ?? null);
        db.close();
    }
    function makeFullCorpus(dir: string, populate: (i: number) => any[] = () => []) {
        for (let i = 0; i < META_SHARD_COUNT; i++) makeShard(dir, i, populate(i));
    }
    function run(dir: string) {
        const results: { label: string; pass: boolean; detail: string }[] = [];
        verifyCitationIntegrity(dir, (label: string, pass: boolean, detail = '') => results.push({ label, pass, detail }));
        return results;
    }
    const gate = (r: { label: string; pass: boolean }[]) =>
        r.find(x => x.label === 'Citation: no internal Free2AITools URL')!;

    afterAll(() => { for (const root of tmpRoots) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } } });

    it('absolute internal url in a packed citation -> gate FAILS', () => {
        const dir = newDir('citation-internalurl-bad-');
        makeFullCorpus(dir, i => (i === 0 ? [
            { id: 'p1', slug: 's1', citation: cit('https://free2aitools.com/papers/p1') },
        ] : []));
        const g = gate(run(dir));
        expect(g.pass).toBe(false);
        expect(g.detail).toContain('1 of');
    });

    it('only genuine external urls -> gate PASSES (no false positive)', () => {
        const dir = newDir('citation-internalurl-good-');
        makeFullCorpus(dir, i => (i === 0 ? [
            { id: 'p1', slug: 's1', citation: cit('https://arxiv.org/abs/1706.03762') },
            { id: 'p2', slug: 's2', citation: cit('https://github.com/org/repo') },
        ] : []));
        const g = gate(run(dir));
        expect(g.pass).toBe(true);
        expect(g.detail).toContain('0 of');
    });
});
