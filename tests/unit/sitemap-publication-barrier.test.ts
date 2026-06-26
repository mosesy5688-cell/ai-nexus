import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
// @ts-ignore — JS factory module, no types.
import {
    isSitemapChild, isSitemapIndex, classifySitemapObjects,
    parseIndexChildLocs, verifyChildrenPresent, publishSitemapIndex,
} from '../../scripts/factory/lib/sitemap-publication.js';

// D-140 Lane S-A §5 — CHILD-BEFORE-INDEX PUBLICATION BARRIER. The index is held
// out of the Phase-1 concurrency batch and published in Phase 2 ONLY after every
// referenced child is uploaded AND verified present on R2. One missing/failed
// child -> CHILD_UPLOAD_INCOMPLETE -> INDEX_NOT_PUBLISHED -> JOB_FAIL (fail-loud).

let tmp: string;
function writeIndex(children: number[]): string {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex>\n';
    for (const n of children) xml += `  <sitemap><loc>https://free2aitools.com/sitemaps/sitemap-${n}.xml.gz</loc></sitemap>\n`;
    xml += '</sitemapindex>';
    const p = path.join(tmp, 'sitemap-index.xml');
    fs.writeFileSync(p, xml);
    return p;
}

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-pub-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('§5 discrimination (filename, not lexical sort)', () => {
    it('1. child vs index are distinguished by remote path', () => {
        expect(isSitemapChild('sitemaps/sitemap-1.xml.gz')).toBe(true);
        expect(isSitemapChild('sitemaps/sitemap-12.xml')).toBe(true);
        expect(isSitemapIndex('sitemaps/sitemap-index.xml')).toBe(true);
        expect(isSitemapIndex('sitemap.xml')).toBe(true);
        expect(isSitemapChild('sitemaps/sitemap-index.xml')).toBe(false);
        expect(isSitemapIndex('sitemaps/sitemap-1.xml.gz')).toBe(false);
    });

    it('2. classify holds the index OUT of the others/children Phase-1 set', () => {
        const items = [
            { remotePath: 'sitemaps/sitemap-1.xml.gz' },
            { remotePath: 'sitemaps/sitemap-index.xml' },
            { remotePath: 'cache/x.json' },
            { remotePath: 'sitemap.xml' },
        ];
        const { children, index, others } = classifySitemapObjects(items);
        expect(children.map(c => c.remotePath)).toEqual(['sitemaps/sitemap-1.xml.gz']);
        expect(index.map(i => i.remotePath).sort()).toEqual(['sitemap.xml', 'sitemaps/sitemap-index.xml']);
        // others (Phase 1) MUST NOT contain the index objects.
        expect(others.some(o => isSitemapIndex(o.remotePath))).toBe(false);
        expect(others.map(o => o.remotePath)).toContain('sitemaps/sitemap-1.xml.gz');
    });
});

describe('§5 child reference parsing + verification', () => {
    it('3. parseIndexChildLocs returns exact referenced children', async () => {
        const p = writeIndex([1, 2, 3]);
        expect(await parseIndexChildLocs(p)).toEqual([
            'sitemaps/sitemap-1.xml.gz', 'sitemaps/sitemap-2.xml.gz', 'sitemaps/sitemap-3.xml.gz',
        ]);
    });

    it('4. verifyChildrenPresent reports the missing set', async () => {
        const head = async (rp: string) => ({ exists: rp.includes('sitemap-2') ? false : true });
        const r = await verifyChildrenPresent(['sitemaps/sitemap-1.xml.gz', 'sitemaps/sitemap-2.xml.gz'], head);
        expect(r.ok).toBe(false);
        expect(r.missing).toEqual(['sitemaps/sitemap-2.xml.gz']);
    });

    it('5. a HEAD that throws (transient/credential) propagates fail-loud', async () => {
        const head = async () => { throw new Error('HEAD failed: connreset'); };
        await expect(verifyChildrenPresent(['sitemaps/sitemap-1.xml.gz'], head)).rejects.toThrow(/HEAD failed/);
    });
});

describe('§5 publishSitemapIndex — child-before-index ordering', () => {
    const indexItems = (p: string) => [{ localPath: p, remotePath: 'sitemaps/sitemap-index.xml' }];

    it('6. children verified -> index uploaded EXACTLY once, status INDEX_PUBLISHED', async () => {
        const p = writeIndex([1, 2]);
        const uploads: string[] = [];
        const r = await publishSitemapIndex({
            phase1Ok: true, indexItems: indexItems(p), candidateIndexLocalPath: p,
            headFn: async () => ({ exists: true }),
            uploadFn: async (_lp: string, rp: string) => { uploads.push(rp); return { success: true }; },
            log: () => {},
        });
        expect(r.published).toBe(true);
        expect(r.status).toBe('INDEX_PUBLISHED');
        expect(r.candidateChildren).toBe(2);
        expect(uploads).toEqual(['sitemaps/sitemap-index.xml']); // exactly once
    });

    it('7. one MISSING (unchanged-but-absent) child BLOCKS publication; index NOT uploaded', async () => {
        const p = writeIndex([1, 2]);
        const uploads: string[] = [];
        const r = await publishSitemapIndex({
            phase1Ok: true, indexItems: indexItems(p), candidateIndexLocalPath: p,
            headFn: async (rp: string) => ({ exists: !rp.includes('sitemap-2') }),
            uploadFn: async (_lp: string, rp: string) => { uploads.push(rp); return { success: true }; },
            log: () => {},
        });
        expect(r.published).toBe(false);
        expect(r.status).toBe('CHILD_UPLOAD_INCOMPLETE -> INDEX_NOT_PUBLISHED');
        expect(uploads).toEqual([]); // OLD index left in place
    });

    it('8. unchanged-but-EXISTING child passes verification (exists:true via HEAD)', async () => {
        const p = writeIndex([5]);
        const r = await publishSitemapIndex({
            phase1Ok: true, indexItems: indexItems(p), candidateIndexLocalPath: p,
            headFn: async () => ({ exists: true, etag: 'abc' }),
            uploadFn: async () => ({ success: true }),
            log: () => {},
        });
        expect(r.published).toBe(true);
        expect(r.verifiedChildren).toBe(1);
    });

    it('9. a Phase-1 child upload failure (phase1Ok=false) blocks publication', async () => {
        const p = writeIndex([1]);
        let headCalled = false;
        const r = await publishSitemapIndex({
            phase1Ok: false, indexItems: indexItems(p), candidateIndexLocalPath: p,
            headFn: async () => { headCalled = true; return { exists: true }; },
            uploadFn: async () => ({ success: true }),
            log: () => {},
        });
        expect(r.published).toBe(false);
        expect(r.status).toBe('CHILD_UPLOAD_INCOMPLETE -> INDEX_NOT_PUBLISHED');
        expect(headCalled).toBe(false); // short-circuits before verifying
    });
});

describe('§5/§6 mutation proofs — reintroducing the defect MUST fail', () => {
    it('M4. putting the index back in the concurrent child queue is rejected', () => {
        // classify guarantees the index is never in `others`/`children` (Phase 1).
        const { others, children } = classifySitemapObjects([{ remotePath: 'sitemaps/sitemap-index.xml' }]);
        expect(others).toEqual([]);
        expect(children).toEqual([]);
    });

    it('M5. swallowing a child failure (returning published) is impossible', async () => {
        const p = writeIndex([1]);
        const r = await publishSitemapIndex({
            phase1Ok: true, indexItems: [{ localPath: p, remotePath: 'sitemaps/sitemap-index.xml' }],
            candidateIndexLocalPath: p,
            headFn: async () => ({ exists: false }), // child missing
            uploadFn: async () => ({ success: true }),
            log: () => {},
        });
        // Must NOT silently publish — published stays false, status is fail-loud.
        expect(r.published).toBe(false);
        expect(r.status).toContain('INDEX_NOT_PUBLISHED');
    });

    it('M6. publishing index after partial completion is rejected', async () => {
        const p = writeIndex([1, 2, 3]);
        const r = await publishSitemapIndex({
            phase1Ok: true, indexItems: [{ localPath: p, remotePath: 'sitemaps/sitemap-index.xml' }],
            candidateIndexLocalPath: p,
            headFn: async (rp: string) => ({ exists: rp.includes('sitemap-1') }), // only 1 of 3 present
            uploadFn: async () => ({ success: true }),
            log: () => {},
        });
        expect(r.published).toBe(false);
        expect(r.verifiedChildren).toBe(1);
        expect(r.candidateChildren).toBe(3);
    });
});
