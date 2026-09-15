import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

// Both meta-anchors producers bound `umid` as ''. '' is a value, so rows that
// declared no umid collided with each other on `umid TEXT UNIQUE`, and INSERT
// OR REPLACE deletes the conflicting row: each such insert evicted the previous
// one, while the log reported the number of insert CALLS. A row that did
// declare a umid was not affected - measured, 5 inserts of which 2 carried a
// real umid leave 3 rows. Measured on 021a28fc with 3 distinct umid-less
// inputs: "3 articles indexed" / "3 reports indexed" over SELECT COUNT(*) = 1
// in both tables. These assert reported == COUNT(*) == inputs, and that the
// knowledge line no longer sums gate rejections with destroyed articles.

const workspaces: string[] = [];

async function workspace() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-anchors-'));
    workspaces.push(root);
    const out = path.join(root, 'data');
    const cache = path.join(root, 'cache');
    await fs.mkdir(out, { recursive: true });
    await fs.mkdir(path.join(cache, 'knowledge', 'articles'), { recursive: true });
    await fs.mkdir(path.join(cache, 'reports', 'daily'), { recursive: true });
    return { out, cache };
}

/** OUTPUT_DIR/CACHE_DIR are read at module scope, so re-import per workspace. */
async function load(out: string, cache: string) {
    process.env.OUTPUT_DIR = out;
    process.env.CACHE_DIR = cache;
    vi.resetModules();
    return await import('../../scripts/factory/lib/meta-anchors.js');
}

function captureLog() {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(' '));
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    return lines;
}

/**
 * The first integer the log prints for this database. Deliberately tolerant of
 * wording so the assertion reads the same number on the pre-fix revision (where
 * the line says "N articles indexed") as on this one.
 */
function reported(lines: string[], marker: string): number {
    const line = lines.find(l => l.includes(marker));
    expect(line, `no log line containing "${marker}"`).toBeDefined();
    const tail = line!.slice(line!.indexOf(marker) + marker.length);
    const m = /(\d+)/.exec(tail);
    expect(m, `no count in log line: ${line}`).not.toBeNull();
    return Number(m![1]);
}

function readRows(out: string, dbFile: string) {
    const db = new Database(path.join(out, dbFile), { readonly: true });
    const rows = db.prepare('SELECT id, umid FROM articles ORDER BY id').all() as
        Array<{ id: string; umid: string | null }>;
    db.close();
    return rows;
}

async function writeArticle(cache: string, name: string, payload: unknown) {
    const file = path.join(cache, 'knowledge', 'articles', name);
    await fs.writeFile(file, JSON.stringify(payload));
}

async function writeReport(cache: string, id: string, payload: unknown) {
    const file = path.join(cache, 'reports', 'daily', `${id}.json`);
    await fs.writeFile(file, JSON.stringify(payload));
}

afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.OUTPUT_DIR;
    delete process.env.CACHE_DIR;
    while (workspaces.length) {
        await fs.rm(workspaces.pop()!, { recursive: true, force: true }).catch(() => {});
    }
});

describe('A1 - the number the log reports is the number of rows that exist', () => {
    it('buildKnowledgeDb: 4 distinct articles produce 4 rows and report 4', async () => {
        const { out, cache } = await workspace();
        const slugs = ['alpha', 'beta', 'delta', 'gamma'];
        for (const s of slugs) {
            await writeArticle(cache, `${s}.json`, {
                title: `Title ${s}`, slug: s, summary: `summary ${s}`,
                content: `body ${s}`, published_at: '2026-09-01',
            });
        }
        const lines = captureLog();
        const mod = await load(out, cache);
        await mod.buildKnowledgeDb();

        const rows = readRows(out, 'meta-knowledge.db');
        // One assertion so a pre-fix run prints the whole shape at once:
        // { reported: 4, rows: 1, inputs: 4 }.
        expect({
            reported: reported(lines, 'meta-knowledge.db:'),
            rows: rows.length,
            inputs: slugs.length,
        }).toEqual({ reported: 4, rows: 4, inputs: 4 });
        expect(rows.map(r => r.id)).toEqual(slugs);
    });

    it('buildReportDb: 4 distinct reports produce 4 rows and report 4', async () => {
        const { out, cache } = await workspace();
        const days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'];
        for (const d of days) {
            await writeReport(cache, d, {
                id: `report-${d}`, title: `Report ${d}`, summary: 'x',
                content: 'y', published_at: d,
            });
        }
        const lines = captureLog();
        const mod = await load(out, cache);
        await mod.buildReportDb();

        const rows = readRows(out, 'meta-report.db');
        expect({
            reported: reported(lines, 'meta-report.db:'),
            rows: rows.length,
            inputs: days.length,
        }).toEqual({ reported: 4, rows: 4, inputs: 4 });
        expect(rows.map(r => r.id)).toEqual(days.map(d => `report-${d}`));
    });
});

describe('A3 - records that carry no umid coexist instead of evicting', () => {
    it('two umid-less articles both survive, and both store NULL not empty', async () => {
        const { out, cache } = await workspace();
        for (const s of ['first', 'second']) {
            await writeArticle(cache, `${s}.json`, { title: `T ${s}`, slug: s, content: `c ${s}` });
        }
        captureLog();
        const mod = await load(out, cache);
        await mod.buildKnowledgeDb();

        const rows = readRows(out, 'meta-knowledge.db');
        expect(rows.map(r => r.id)).toEqual(['first', 'second']);
        for (const r of rows) expect(r.umid).toBeNull();

        const db = new Database(path.join(out, 'meta-knowledge.db'), { readonly: true });
        const nulls = db.prepare('SELECT COUNT(*) AS c FROM articles WHERE umid IS NULL').get() as { c: number };
        const blanks = db.prepare("SELECT COUNT(*) AS c FROM articles WHERE umid = ''").get() as { c: number };
        db.close();
        expect(nulls.c).toBe(2);
        expect(blanks.c).toBe(0);
    });

    it('a declared umid is still stored and still enforced as unique', async () => {
        const { out, cache } = await workspace();
        await writeArticle(cache, 'one.json', { title: 'One', slug: 'one', umid: 'umid-1', content: 'a' });
        await writeArticle(cache, 'two.json', { title: 'Two', slug: 'two', umid: 'umid-2', content: 'b' });
        captureLog();
        const mod = await load(out, cache);
        await mod.buildKnowledgeDb();

        const rows = readRows(out, 'meta-knowledge.db');
        expect(rows).toEqual([{ id: 'one', umid: 'umid-1' }, { id: 'two', umid: 'umid-2' }]);
    });
});

describe('R2 - a gate rejection and a destroyed article are counted separately', () => {
    it('reports the artifact and the bind failure under distinct names', async () => {
        const { out, cache } = await workspace();
        // admitted by the gate and inserted
        await writeArticle(cache, 'good.json', { title: 'Good', slug: 'good', content: 'text' });
        // reserved basename: the identity gate excludes it, which is correct
        const indexFile = path.join(cache, 'knowledge', 'index.json');
        await fs.writeFile(indexFile, JSON.stringify([{ slug: 'good' }]));
        // admitted by the gate, then destroyed by a bind the driver refuses.
        // knowledge-data-generator.js sets `content` to the object that
        // extractSections() returns. Not fixed here (separate track); this
        // fixture checks that it is not counted as an excluded artifact.
        await writeArticle(cache, 'broken.json', {
            title: 'Broken', slug: 'broken', content: { sections: [{ h: 'x' }] },
        });

        const lines = captureLog();
        const mod = await load(out, cache);
        await mod.buildKnowledgeDb();

        expect(readRows(out, 'meta-knowledge.db').map(r => r.id)).toEqual(['good']);

        const line = lines.find(l => l.includes('meta-knowledge.db:'))!;
        expect(line).toMatch(/1 article row\(s\) indexed/);
        expect(line).toMatch(/1 non-article candidate\(s\) excluded by the identity gate/);
        expect(line).toMatch(/1 article\(s\) lost to an error/);
        // the two kinds must not be summed back into one number
        expect(line).not.toMatch(/2 candidate\(s\) rejected/);
    });

    it('a clean run reports zero for both rejection kinds', async () => {
        const { out, cache } = await workspace();
        for (const s of ['p', 'q', 'r']) {
            await writeArticle(cache, `${s}.json`, { title: `T ${s}`, slug: s, content: `c ${s}` });
        }
        const lines = captureLog();
        const mod = await load(out, cache);
        await mod.buildKnowledgeDb();

        const line = lines.find(l => l.includes('meta-knowledge.db:'))!;
        expect(line).toMatch(/3 article row\(s\) indexed \(3 insert\(s\) attempted\)/);
        expect(line).toMatch(/0 non-article candidate\(s\) excluded/);
        expect(line).toMatch(/0 article\(s\) lost to an error/);
    });
});

// With the umid fix in place, attempted == rows whenever nothing is replaced,
// so those fixtures cannot tell "report the surviving row count" apart from
// "report the insert-call count". These two force a replace so they diverge.
describe('R2 - the logged count is rows that survived, not insert calls', () => {
    it('buildKnowledgeDb: two files with one shared slug log 1 row of 2 attempts', async () => {
        const { out, cache } = await workspace();
        await writeArticle(cache, 'dup-a.json', { title: 'A', slug: 'dup', content: 'a' });
        await writeArticle(cache, 'dup-b.json', { title: 'B', slug: 'dup', content: 'b' });
        const lines = captureLog();
        const mod = await load(out, cache);
        await mod.buildKnowledgeDb();

        const rows = readRows(out, 'meta-knowledge.db');
        expect(rows.length).toBe(1);
        expect(reported(lines, 'meta-knowledge.db:')).toBe(1);
        expect(lines.find(l => l.includes('meta-knowledge.db:'))).toMatch(/\(2 insert\(s\) attempted\)/);
    });

    it('buildReportDb: two reports sharing one umid log 1 row of 2 attempts', async () => {
        const { out, cache } = await workspace();
        for (const d of ['2026-09-01', '2026-09-02']) {
            await writeReport(cache, d, { id: `report-${d}`, title: d, umid: 'shared', content: 'c' });
        }
        const lines = captureLog();
        const mod = await load(out, cache);
        await mod.buildReportDb();

        const rows = readRows(out, 'meta-report.db');
        expect(rows.length).toBe(1);
        expect(reported(lines, 'meta-report.db:')).toBe(1);
        expect(lines.find(l => l.includes('meta-report.db:'))).toMatch(/\(2 insert\(s\) attempted/);
    });
});
