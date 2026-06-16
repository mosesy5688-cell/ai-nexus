// tests/unit/citation-chokepoint.test.ts
// P3-EVIDENCE-1 STAGE-B — FINAL CITATION AUTHORITY at the pack chokepoint.
//
// buildEntityRow (scripts/factory/lib/row-builders.js) is the SINGLE final point
// every entity is written through into the 96 meta-NN.db (pack-db.js:154). Before
// STAGE-B it packed the RAW `e.citation` (`tr(e.citation, 500)`), so a stale/legacy
// raw citation carrying an id/slug/hash-as-title or an empty shell could pass through
// unverified. STAGE-B RE-DERIVES the packed value from the same pure normalizer the
// upstream uses (normalizeCitation), so the column is authoritative regardless of
// what `e.citation` already held.
//
// These tests assert the CHOKEPOINT contract (complementing citation-integrity.test.ts
// which exercises normalizeCitation + the bake canary directly):
//   1. unit: the authority RE-DERIVES (raw e.citation is ignored; output == normalizer)
//   2. mini-pack: a tiny entity set built through buildEntityRow into a REAL in-memory
//      SQLite (the authoritative entitiesTableSql) — query the packed `citation` column
//      to prove raw e.citation no longer survives and degenerate inputs pack as NULL.
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
// @ts-ignore - JS ESM producer (no .d.ts); tested for its runtime contract.
import { buildEntityRow } from '../../scripts/factory/lib/row-builders.js';
// @ts-ignore - the shared single citation authority (same one row-builders re-derives with).
import { normalizeCitation } from '../../scripts/factory/lib/umid-generator.js';
// @ts-ignore - the authoritative entities schema the packer writes into.
import { entitiesTableSql } from '../../scripts/factory/lib/pack-schemas.js';

// buildEntityRow positional extras (fniMetrics, pBillions, arch, ctxLen, category,
// tags, summary, bundleKey, offset, size). The citation column is RE-DERIVED from the
// entity object alone, so these are inert filler for that assertion.
const FNI = { s: 0, a: 0, p: 0, r: 0, q: 0 };
function rowOf(e: any): any[] {
    return buildEntityRow(e, FNI, 0, '', 0, 'misc', '', 'sum', null, 0, 0);
}
// Column index of `citation` in the buildEntityRow array == its ordinal in
// entitiesTableSql (single-source schema; pack-db.js asserts row/col parity).
const CITATION_COL_INDEX = (() => {
    const body = entitiesTableSql.slice(entitiesTableSql.indexOf('(') + 1, entitiesTableSql.lastIndexOf(')'));
    const cols = body.split(',').map((c: string) => c.trim().split(/\s+/)[0]).filter(Boolean);
    return cols.indexOf('citation');
})();

const base = { id: 'arxiv-paper--2401--attention', slug: 'attention-is-all-you-need', type: 'paper' };

describe('STAGE-B chokepoint — buildEntityRow re-derives citation (unit)', () => {
    it('citation column index resolves (schema sanity)', () => {
        expect(CITATION_COL_INDEX).toBeGreaterThan(0);
    });

    it('genuine title -> packed citation EQUALS the normalizer output (re-derived, not raw)', () => {
        const e = { ...base, name: 'Attention Is All You Need', published_year: 2017,
            // a DIFFERENT raw e.citation that must be IGNORED (proves re-derivation):
            citation: '@misc{stale,title={STALE RAW VALUE},note={x}}' };
        const packed = rowOf(e)[CITATION_COL_INDEX];
        expect(packed).toBe(normalizeCitation(e));
        expect(packed).toContain('title={Attention Is All You Need}');
        expect(packed).not.toContain('STALE RAW VALUE'); // raw passthrough is gone
    });

    it('raw e.citation with id-as-title is DROPPED -> packed NULL (no passthrough)', () => {
        // legacy raw carries a fabricated id-as-title; the entity has NO genuine title.
        const e = { ...base, citation: `@misc{x,title={${base.id}},note={x}}` };
        expect(rowOf(e)[CITATION_COL_INDEX]).toBeNull();
    });

    it('raw e.citation present but no genuine title -> packed NULL', () => {
        const e = { id: 'gh-tool--y', slug: 'y', type: 'tool',
            citation: '@misc{y,title={y},author={Unknown},note={x}}' };
        expect(rowOf(e)[CITATION_COL_INDEX]).toBeNull();
    });

    it('hash-like / placeholder titles -> packed NULL (even when raw citation set)', () => {
        const hashE = { id: 'x', slug: 'x', name: 'a1b2c3d4e5f60718', citation: '@misc{x,title={a1b2c3d4e5f60718}}' };
        const unkE = { id: 'x', slug: 'x', name: 'Unknown', citation: '@misc{x,title={Unknown}}' };
        expect(rowOf(hashE)[CITATION_COL_INDEX]).toBeNull();
        expect(rowOf(unkE)[CITATION_COL_INDEX]).toBeNull();
    });

    it('no raw citation + genuine title -> still derives a real citation', () => {
        const e = { ...base, name: 'Attention Is All You Need' }; // e.citation undefined
        const packed = rowOf(e)[CITATION_COL_INDEX];
        expect(packed).toBe(normalizeCitation(e));
        expect(packed).toMatch(/^@misc\{/);
    });

    it('object author array never packs "[object Object]"; no url/year residue when absent', () => {
        const e = { ...base, name: 'BERT', author: [{ authorId: '1', name: 'J. Devlin' }] };
        const packed = rowOf(e)[CITATION_COL_INDEX] as string;
        expect(packed).toContain('author={J. Devlin}');
        expect(packed).not.toContain('[object Object]');
        expect(packed).not.toContain('url=');
        expect(packed).not.toContain('year=');
    });

    it('truncates an over-long derived citation to the 500-char column budget', () => {
        const e = { ...base, name: 'T'.repeat(2000) };
        const packed = rowOf(e)[CITATION_COL_INDEX] as string;
        expect(typeof packed).toBe('string');
        expect(packed.length).toBeLessThanOrEqual(500);
    });
});

describe('STAGE-B chokepoint — mini-pack SQLite proves packed column (integration)', () => {
    it('builds entities through buildEntityRow into the real schema; queries citation', () => {
        const db = new Database(':memory:');
        db.exec(entitiesTableSql);
        const cols = db.prepare('PRAGMA table_info(entities)').all() as Array<{ name: string }>;
        const placeholders = cols.map(() => '?').join(',');
        const ins = db.prepare(`INSERT INTO entities VALUES (${placeholders})`);

        const entities = [
            // genuine -> real citation re-derived (raw value below MUST be ignored)
            { id: 'p1', slug: 'attention', name: 'Attention Is All You Need', type: 'paper',
              published_year: 2017, citation: '@misc{raw,title={RAW LEAK},note={x}}' },
            // id-as-title raw legacy -> NULL
            { id: 'p2', slug: 'bert-id', name: '   ', type: 'paper',
              citation: '@misc{p2,title={p2},note={x}}' },
            // hash-like raw -> NULL
            { id: 'p3', slug: 'h', name: 'deadbeefdeadbeef', type: 'model',
              citation: '@misc{p3,title={deadbeefdeadbeef}}' },
            // genuine, no raw citation at all -> real citation
            { id: 'p4', slug: 'gpt', name: 'GPT Technical Report', type: 'paper' },
        ];
        for (const e of entities) ins.run(...rowOf(e));

        const get = db.prepare('SELECT citation FROM entities WHERE id = ?');
        const c1 = (get.get('p1') as any).citation as string | null;
        const c2 = (get.get('p2') as any).citation as string | null;
        const c3 = (get.get('p3') as any).citation as string | null;
        const c4 = (get.get('p4') as any).citation as string | null;
        db.close();

        // p1: re-derived genuine citation, raw "RAW LEAK" eliminated.
        expect(c1).toContain('title={Attention Is All You Need}');
        expect(c1).toContain('year={2017}');
        expect(c1).not.toContain('RAW LEAK');
        expect(c1).not.toContain('[object Object]');
        // p2 + p3: degenerate -> packed as SQL NULL (honest "no citation"), not '' or raw.
        expect(c2).toBeNull();
        expect(c3).toBeNull();
        // p4: genuine title with no raw citation still produces a real citation.
        expect(c4).toContain('title={GPT Technical Report}');
        expect(c4).toMatch(/^@misc\{/);

        // The bake canary HASH_LIKE / id-as-title contract would reject c2/c3 raw —
        // proving the chokepoint pre-empts them by packing NULL.
        for (const c of [c2, c3]) expect(typeof c !== 'string' || !c).toBe(true);
    });
});
