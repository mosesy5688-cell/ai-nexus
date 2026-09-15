import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import Database from 'better-sqlite3';
import {
    workspace, cleanup, load, captureLog, logLine, reported, quantity,
    readRows, writeArticle, writeReport,
} from './meta-anchors-fixture';

// Both meta-anchors producers bound `umid` as ''. '' is a value, so rows that
// declared no umid collided with each other on `umid TEXT UNIQUE`, and INSERT
// OR REPLACE deletes the conflicting row: each such insert evicted the previous
// one, while the log reported the number of insert.run calls. A row that did
// declare a umid was not affected - measured, 5 inserts of which 2 carried a
// real umid leave 3 rows. Measured on 021a28fc with 3 distinct umid-less
// inputs: "3 articles indexed" / "3 reports indexed" over SELECT COUNT(*) = 1
// in both tables. These assert rows == inputs and that the surviving-row count
// and the completed-call count are logged as two separately named quantities.

afterEach(cleanup);

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

        expect(readRows(out, 'meta-knowledge.db')).toEqual([
            { id: 'one', umid: 'umid-1' }, { id: 'two', umid: 'umid-2' },
        ]);
    });
});

// With the umid fix in place, completed calls == rows whenever nothing is
// replaced, so those fixtures cannot tell "report the surviving row count" apart
// from "report the completed-call count". These two force a replace so the
// numbers diverge, and each is asserted under its own name in the log.
describe('R2 - surviving rows and completed insert.run calls are separate quantities', () => {
    it('buildKnowledgeDb: two files with one shared slug give 1 row of 2 calls', async () => {
        const { out, cache } = await workspace();
        await writeArticle(cache, 'dup-a.json', { title: 'A', slug: 'dup', content: 'a' });
        await writeArticle(cache, 'dup-b.json', { title: 'B', slug: 'dup', content: 'b' });
        const lines = captureLog();
        const mod = await load(out, cache);
        await mod.buildKnowledgeDb();

        const line = logLine(lines, 'meta-knowledge.db:');
        expect(readRows(out, 'meta-knowledge.db').length).toBe(1);
        expect(reported(lines, 'meta-knowledge.db:')).toBe(1);
        expect(quantity(line, 'row\\(s\\) in articles')).toBe(1);
        expect(quantity(line, 'insert\\.run call\\(s\\) completed')).toBe(2);
    });

    it('buildReportDb: two reports sharing one umid give 1 row of 2 calls', async () => {
        const { out, cache } = await workspace();
        for (const d of ['2026-09-01', '2026-09-02']) {
            await writeReport(cache, d, { id: `report-${d}`, title: d, umid: 'shared', content: 'c' });
        }
        const lines = captureLog();
        const mod = await load(out, cache);
        await mod.buildReportDb();

        const line = logLine(lines, 'meta-report.db:');
        expect(readRows(out, 'meta-report.db').length).toBe(1);
        expect(quantity(line, 'row\\(s\\) in articles')).toBe(1);
        expect(quantity(line, 'insert\\.run call\\(s\\) completed')).toBe(2);
    });
});
