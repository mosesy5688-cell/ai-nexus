// tests/unit/mesh-degenerate-name.test.ts
//
// PR fix/mesh-degenerate-name-fallback -- name-less entities must get an HONEST
// humanized display name (derived from their own real id/slug), never a
// degenerate `name === id` echo.
//
// ROOT CAUSE (bake canary: "Mesh Resolution: N unresolved/concept-stub of M
// served edges (need 0)"): a name-less entity was stored in entity_lookup with
// name = id (the caller pack-db.js:114 coalesces a missing name to the id, and
// the lookup producers fell back to `name || id`). resolveMeshEdge KEEPS such an
// edge (it resolves to a real packed entity), but isResolvedMeshNode -- the bake
// canary in mesh-resolve-filter.js:75 -- correctly rejects `name === id`.
//
// FIX: the lookup producers (entity-lookup-cache.js flush, pack-accumulator.js
// ingest + getEntityLookup) now fall back to humanizeId(id): de-kebab the real
// id/slug tail to a readable, canary-safe (`!== id`) display name. This is
// display FORMATTING of the entity's true identifier, not invented metadata.
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { humanizeId } from '../../scripts/factory/lib/derive-slug.js';
import { createEntityLookupAccess } from '../../scripts/factory/lib/entity-lookup-cache.js';
import { PackAccumulator } from '../../scripts/factory/lib/pack-accumulator.js';
import { isResolvedMeshNode } from '../../scripts/factory/lib/mesh-resolve-filter.js';
import os from 'os';
import path from 'path';

// A real-shaped name-less entity id (the prefix is stripped, the tail de-kebabbed).
const NAMELESS_ID = 'hf-model--acme-research/llama-3-8b-instruct';
// A bare, pathological id with no separators -> the humanized tail could equal id.
const BARE_ID = 'singletoken';

describe('humanizeId (shared helper)', () => {
    it('de-kebabs the real id tail into a readable, non-id name', () => {
        const name = humanizeId(NAMELESS_ID);
        expect(name).toBeTruthy();
        expect(name).not.toBe(NAMELESS_ID);
        // de-kebabbed tail of `.../llama-3-8b-instruct`
        expect(name).toBe('llama 3 8b instruct');
        // a humanized string has spaces; the id does not -> canary-safe by design.
        expect(name).toContain(' ');
    });

    it('never re-emits the id even for a bare, separator-less id', () => {
        const name = humanizeId(BARE_ID);
        expect(name).toBeTruthy();
        expect(name).not.toBe(BARE_ID);
    });

    it('returns a readable placeholder (never empty / never the id) for empty id', () => {
        const name = humanizeId('');
        expect(name).toBeTruthy();
        expect(name).not.toBe('');
    });
});

describe('entity-lookup-cache flush: empty-name -> humanized (not id echo)', () => {
    function makeCacheDb() {
        const db = new Database(':memory:');
        db.exec(
            'CREATE TABLE entity_lookup (id TEXT PRIMARY KEY, name TEXT, icon TEXT)'
        );
        return db;
    }

    it('stores a humanized name (non-empty, !== id) for a name-less entity', () => {
        const db = makeCacheDb();
        const { trackEntity, flush, lookup } = createEntityLookupAccess(db);
        // Empty name: exactly the name-less corpus case (~8.3% of entities).
        trackEntity(NAMELESS_ID, '', '');
        flush();
        const hit = lookup.get(NAMELESS_ID);
        expect(hit).toBeTruthy();
        expect(hit.name).toBeTruthy();
        expect(hit.name).not.toBe(NAMELESS_ID);
        expect(hit.name).toBe('llama 3 8b instruct');
        // The served node this produces MUST satisfy the strict bake canary.
        expect(isResolvedMeshNode({ id: NAMELESS_ID, name: hit.name })).toBe(true);
    });

    it('repairs the caller`s name===id echo (pack-db.js coalesces missing -> id)', () => {
        const db = makeCacheDb();
        const { trackEntity, flush, lookup } = createEntityLookupAccess(db);
        // Real prod path: pack-db.js passes `e.name || e.displayName || eid`,
        // so a name-less entity arrives here already echoing the id as its name.
        trackEntity(NAMELESS_ID, NAMELESS_ID, '');
        flush();
        const hit = lookup.get(NAMELESS_ID);
        expect(hit.name).not.toBe(NAMELESS_ID);
        expect(isResolvedMeshNode({ id: NAMELESS_ID, name: hit.name })).toBe(true);
    });

    it('preserves a genuine real name untouched', () => {
        const db = makeCacheDb();
        const { trackEntity, flush, lookup } = createEntityLookupAccess(db);
        trackEntity(NAMELESS_ID, 'Llama 3 8B Instruct', 'I');
        flush();
        expect(lookup.get(NAMELESS_ID).name).toBe('Llama 3 8B Instruct');
    });
});

describe('entity-lookup-cache READ: restored stale row (name===id) -> humanized', () => {
    // Production mode #2166 MISSED: a RESTORED entity_lookup row (written by an
    // OLD `name || id` flush in an earlier cycle) already holds name === id. The
    // distiller reads it DURING the main pass (before flush), and flush's
    // INSERT OR IGNORE can never overwrite it. So the READ accessor must humanize.
    function makeCacheDb() {
        const db = new Database(':memory:');
        db.exec(
            'CREATE TABLE entity_lookup (id TEXT PRIMARY KEY, name TEXT, icon TEXT)'
        );
        return db;
    }

    const RESTORED_ID = 'hf-model--x--y';

    it('humanizes a pre-existing row whose stored name === id', () => {
        const db = makeCacheDb();
        // Directly insert a stale restored row (name === id) -- NOT via trackEntity.
        db.prepare('INSERT INTO entity_lookup (id, name, icon) VALUES (?, ?, ?)')
            .run(RESTORED_ID, RESTORED_ID, '');
        const { lookup } = createEntityLookupAccess(db);
        const hit = lookup.get(RESTORED_ID);
        expect(hit).toBeTruthy();
        expect(hit.name).toBeTruthy();
        expect(hit.name).not.toBe(RESTORED_ID);
        expect(hit.name).toBe(humanizeId(RESTORED_ID));
        // The served node this produces MUST satisfy the strict bake canary.
        expect(isResolvedMeshNode({ id: RESTORED_ID, name: hit.name })).toBe(true);
    });

    it('humanizes a pre-existing row whose stored name is empty', () => {
        const db = makeCacheDb();
        db.prepare('INSERT INTO entity_lookup (id, name, icon) VALUES (?, ?, ?)')
            .run(RESTORED_ID, '', '📦');
        const { lookup } = createEntityLookupAccess(db);
        const hit = lookup.get(RESTORED_ID);
        expect(hit.name).toBe(humanizeId(RESTORED_ID));
        expect(hit.icon).toBe('📦');
        expect(isResolvedMeshNode({ id: RESTORED_ID, name: hit.name })).toBe(true);
    });

    it('returns a real-named pre-existing row UNCHANGED', () => {
        const db = makeCacheDb();
        db.prepare('INSERT INTO entity_lookup (id, name, icon) VALUES (?, ?, ?)')
            .run(RESTORED_ID, 'Real Model Name', 'I');
        const { lookup } = createEntityLookupAccess(db);
        const hit = lookup.get(RESTORED_ID);
        expect(hit.name).toBe('Real Model Name');
        expect(hit.icon).toBe('I');
    });

    it('returns null for a missing id (no row to humanize)', () => {
        const { lookup } = createEntityLookupAccess(makeCacheDb());
        expect(lookup.get('hf-model--never--inserted')).toBe(null);
    });
});

describe('pack-accumulator getEntityLookup: empty-name -> humanized (not id echo)', () => {
    async function makeAccumulator() {
        const dbPath = path.join(os.tmpdir(), `pack-acc-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
        const acc = new PackAccumulator(dbPath);
        await acc.init();
        return acc;
    }

    const trending = { rank: 999999, is_trending: false };

    it('returns a humanized lookup name (non-empty, !== id) for a name-less entity', async () => {
        const acc = await makeAccumulator();
        acc.beginTransaction();
        acc.ingest({ id: NAMELESS_ID }, trending, 0); // no name / displayName
        acc.commitTransaction();
        const lookup = acc.getEntityLookup();
        const hit = lookup.get(NAMELESS_ID);
        expect(hit).toBeTruthy();
        expect(hit.name).toBeTruthy();
        expect(hit.name).not.toBe(NAMELESS_ID);
        expect(isResolvedMeshNode({ id: NAMELESS_ID, name: hit.name })).toBe(true);
        await acc.close();
    });

    it('preserves a genuine real name through ingest -> lookup', async () => {
        const acc = await makeAccumulator();
        acc.beginTransaction();
        acc.ingest({ id: NAMELESS_ID, name: 'Llama 3 8B Instruct' }, trending, 0);
        acc.commitTransaction();
        expect(acc.getEntityLookup().get(NAMELESS_ID).name).toBe('Llama 3 8B Instruct');
        await acc.close();
    });
});
