import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';
import {
    workspace, cleanup, load, captureLog, logLine, quantity, readRows, writeArticle,
} from './meta-anchors-fixture';

// buildKnowledgeDb's `try` opens at the fs.readFile, and the
// knowledgeArticleIdentity() call is the third statement inside it, so read,
// decompress and parse failures reach the `catch` WITHOUT the gate having run. An earlier revision
// logged that bucket as "article(s) lost to an error" and its comment asserted
// "the gate already admitted this file as an article". Measured against that
// revision with the fixture below: it printed "4 article(s) lost to an error"
// where exactly one article - the post-gate bind failure - was actually lost.
//
// These tests pin the four quantities the line now reports as distinct, and pin
// that no wording claims a lost article or a verified cause.

afterEach(cleanup);

/** One cache holding a candidate for each outcome asserted below. */
async function mixedCache() {
    const { out, cache } = await workspace();
    const kdir = path.join(cache, 'knowledge');
    // PRE-GATE 1: a DIRECTORY whose name passes the name-only filter. readFile
    // throws EISDIR, so the gate never sees it.
    await fs.mkdir(path.join(kdir, 'adir.json'), { recursive: true });
    // PRE-GATE 2: a legacy gzip payload. autoDecompress throws on gzip by design
    // ("[P3] Gzip format detected"), again before the gate.
    // Titleless on purpose: even decompressed it is not an article payload, so
    // "one article lost" below stays unambiguous.
    await fs.writeFile(path.join(kdir, 'legacy.json.gz'), zlib.gzipSync(Buffer.from('{"index":[1,2]}')));
    // PRE-GATE 3: a malformed body. JSON.parse throws, again before the gate.
    await fs.writeFile(path.join(kdir, 'articles', 'bad.json'), '{not json');
    // GATE: a reserved bookkeeping basename. Admitted by the name filter, then
    // declined by the identity gate - the one correct exclusion here.
    await fs.writeFile(path.join(kdir, 'index.json'), JSON.stringify([{ slug: 'x' }]));
    // POST-GATE: the gate admits it, then the driver refuses an object bind.
    // The one candidate here that is a real article and does not reach a row.
    await writeArticle(cache, 'broken.json', {
        title: 'Broken', slug: 'broken', content: { sections: [{ h: 'x' }] },
    });
    // NORMAL: survives to a row.
    await writeArticle(cache, 'good.json', { title: 'Good', slug: 'good', content: 'text' });
    return { out, cache };
}

describe('F1 - the failure bucket does not claim a cause it cannot know', () => {
    it('counts pre-gate and post-gate failures together, apart from gate rejections', async () => {
        const { out, cache } = await mixedCache();
        const lines = captureLog();
        const mod = await load(out, cache);
        await mod.buildKnowledgeDb();

        expect(readRows(out, 'meta-knowledge.db').map(r => r.id)).toEqual(['good']);

        const line = logLine(lines, 'meta-knowledge.db:');
        // Four quantities, none substitutable for another.
        expect(quantity(line, 'row\\(s\\) in articles')).toBe(1);
        expect(quantity(line, 'insert\\.run call\\(s\\) completed')).toBe(1);
        expect(quantity(line, 'non-article candidate\\(s\\) excluded by the identity gate')).toBe(1);
        // 3 pre-gate (directory, gzip, malformed) + 1 post-gate (bind) = 4.
        expect(quantity(line, 'candidate\\(s\\) failed during processing')).toBe(4);
    });

    it('does not call the failure bucket lost or destroyed articles', async () => {
        const { out, cache } = await mixedCache();
        const lines = captureLog();
        const mod = await load(out, cache);
        await mod.buildKnowledgeDb();

        const line = logLine(lines, 'meta-knowledge.db:');
        // The regression this guards: 3 of those 4 were not articles at all.
        expect(line).not.toMatch(/article\(s\) lost/);
        expect(line).not.toMatch(/destroyed/);
        expect(line).not.toMatch(/lost to an error/);
    });

    it('a purely pre-gate failure is not reported as a gate rejection', async () => {
        const { out, cache } = await workspace();
        // Only a malformed body. The gate is never reached for it.
        await fs.writeFile(path.join(cache, 'knowledge', 'articles', 'bad.json'), '{not json');
        const lines = captureLog();
        const mod = await load(out, cache);
        await mod.buildKnowledgeDb();

        const line = logLine(lines, 'meta-knowledge.db:');
        expect(quantity(line, 'non-article candidate\\(s\\) excluded by the identity gate')).toBe(0);
        expect(quantity(line, 'candidate\\(s\\) failed during processing')).toBe(1);
        expect(quantity(line, 'row\\(s\\) in articles')).toBe(0);
    });

    it('a purely gate rejection is not reported as a processing failure', async () => {
        const { out, cache } = await workspace();
        await fs.writeFile(path.join(cache, 'knowledge', 'index.json'), JSON.stringify([{ slug: 'x' }]));
        const lines = captureLog();
        const mod = await load(out, cache);
        await mod.buildKnowledgeDb();

        const line = logLine(lines, 'meta-knowledge.db:');
        expect(quantity(line, 'non-article candidate\\(s\\) excluded by the identity gate')).toBe(1);
        expect(quantity(line, 'candidate\\(s\\) failed during processing')).toBe(0);
    });

    it('a post-gate bind failure is a processing failure, not a gate rejection', async () => {
        const { out, cache } = await workspace();
        await writeArticle(cache, 'broken.json', {
            title: 'Broken', slug: 'broken', content: { sections: [] },
        });
        const lines = captureLog();
        const mod = await load(out, cache);
        await mod.buildKnowledgeDb();

        const line = logLine(lines, 'meta-knowledge.db:');
        expect(quantity(line, 'non-article candidate\\(s\\) excluded by the identity gate')).toBe(0);
        expect(quantity(line, 'candidate\\(s\\) failed during processing')).toBe(1);
        expect(quantity(line, 'insert\\.run call\\(s\\) completed')).toBe(0);
    });

    it('a clean run reports zero for both rejection kinds', async () => {
        const { out, cache } = await workspace();
        for (const s of ['p', 'q', 'r']) {
            await writeArticle(cache, `${s}.json`, { title: `T ${s}`, slug: s, content: `c ${s}` });
        }
        const lines = captureLog();
        const mod = await load(out, cache);
        await mod.buildKnowledgeDb();

        const line = logLine(lines, 'meta-knowledge.db:');
        expect(quantity(line, 'row\\(s\\) in articles')).toBe(3);
        expect(quantity(line, 'insert\\.run call\\(s\\) completed')).toBe(3);
        expect(quantity(line, 'non-article candidate\\(s\\) excluded by the identity gate')).toBe(0);
        expect(quantity(line, 'candidate\\(s\\) failed during processing')).toBe(0);
    });
});

describe('F3 - the report builder names the same quantities the same way', () => {
    it('reports completed calls, not attempts, and does not claim lost reports', async () => {
        const { out, cache } = await workspace();
        // A malformed report body: read succeeds, JSON.parse throws.
        await fs.writeFile(path.join(cache, 'reports', 'daily', 'bad.json'), '{not json');
        const lines = captureLog();
        const mod = await load(out, cache);
        await mod.buildReportDb();

        const line = logLine(lines, 'meta-report.db:');
        expect(quantity(line, 'row\\(s\\) in articles')).toBe(0);
        expect(quantity(line, 'insert\\.run call\\(s\\) completed')).toBe(0);
        expect(quantity(line, 'candidate\\(s\\) failed during processing')).toBe(1);
        expect(line).not.toMatch(/attempted/);
        expect(line).not.toMatch(/lost|destroyed|unreadable/);
    });
});
