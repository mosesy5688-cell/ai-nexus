// PR-GR-C (ruling D-2026-0812-421): HARVEST-PATH stale-shard purge.
//
// THE HAZARD. registry-saver.js saveGlobalRegistry() (aggregator path) purges
// surplus local shards; registry-manager.js save() (harvest path) did not. When
// the harvest-side registry shrinks, surplus high-index shards survive, ride the
// GHA cache, and are read back by loadRegistryShardsSequentially. Because
// registry-manager.js load() inserts with INSERT OR IGNORE over shards in sorted
// filename order, THE FIRST FILE WINS -- a stale ghost can shadow the current
// record for a whole cycle. It also produced the duplicate ids that made OP-GR-B
// self-abandon in run 31563250233.
//
// These tests pin the purge itself and, more importantly, the CONSEQUENCE: a
// reload must no longer see the ghost.
//
// HERMETIC: throwaway tmpdir, real files on disk, no network/credentials/R2.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { purgeStaleLocalShards, LOADER_VISIBLE_SHARD_EXTS } from './lib/registry-utils.js';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ogc-purge-'));
const put = (dir, name, body = 'x') => { fs.writeFileSync(path.join(dir, name), body); return name; };
const ls = (dir) => fs.readdirSync(dir).sort();

test('P1 surplus shards beyond the current count are deleted; current ones survive', async () => {
    const dir = mk();
    try {
        for (const n of [0, 1, 2]) put(dir, `part-00${n}.bin`);
        put(dir, 'part-003.bin');           // stale: a prior, larger save
        put(dir, 'part-004.bin');           // stale
        const r = await purgeStaleLocalShards(dir, 3);
        assert.equal(r.purged, 2);
        assert.deepEqual(r.files.sort(), ['part-003.bin', 'part-004.bin']);
        assert.deepEqual(ls(dir), ['part-000.bin', 'part-001.bin', 'part-002.bin']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('P2 THE CONSEQUENCE: after the purge a reload can no longer see the ghost', async () => {
    // Mirrors loadRegistryShardsSequentially's enumeration: every `part-*` file
    // the loader accepts, in sorted order. Before the purge the ghost is in that
    // set (and, under INSERT OR IGNORE with first-file-wins, could shadow a
    // current record); after the purge it is gone.
    const dir = mk();
    try {
        for (const n of [0, 1]) put(dir, `part-00${n}.bin`);
        const ghost = put(dir, 'part-002.bin');
        const visible = () => fs.readdirSync(dir).filter((f) => /^part-\d+\.(bin|json\.zst|json)$/.test(f)).sort();

        assert.ok(visible().includes(ghost), 'pre-condition: the loader would enumerate the ghost');
        await purgeStaleLocalShards(dir, 2);
        assert.equal(visible().includes(ghost), false, 'the ghost must be unreachable to the loader');
        assert.deepEqual(visible(), ['part-000.bin', 'part-001.bin']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('P3 every loader-visible extension is purged, not just .bin', async () => {
    // Purging only .bin would leave the hazard half-open: the loader also reads
    // .json.zst and .json, and rejects .json.gz loudly.
    const dir = mk();
    try {
        put(dir, 'part-000.bin');
        for (const ext of LOADER_VISIBLE_SHARD_EXTS) put(dir, `part-001${ext}`);
        const r = await purgeStaleLocalShards(dir, 1);
        assert.equal(r.purged, LOADER_VISIBLE_SHARD_EXTS.length);
        assert.deepEqual(ls(dir), ['part-000.bin']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('P4 non-shard files and foreign names are never touched', async () => {
    const dir = mk();
    try {
        put(dir, 'part-000.bin');
        put(dir, '_manifest.json');
        put(dir, 'part-abc.bin');
        put(dir, 'notes.txt');
        const r = await purgeStaleLocalShards(dir, 0);
        assert.deepEqual(r.files, ['part-000.bin'], 'only indexed shard files are eligible');
        assert.deepEqual(ls(dir), ['_manifest.json', 'notes.txt', 'part-abc.bin']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('P5 the index rule is >= currentShardCount, aligned with the aggregator purge', async () => {
    const dir = mk();
    try {
        for (const n of [0, 1, 2, 3]) put(dir, `part-00${n}.bin`);
        const r = await purgeStaleLocalShards(dir, 4);
        assert.equal(r.purged, 0, 'a shard AT index count-1 is current and must survive');
        assert.equal(ls(dir).length, 4);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('P6 non-fatal: a missing directory must not throw (never lose a good save)', async () => {
    const r = await purgeStaleLocalShards(path.join(os.tmpdir(), 'ogc-does-not-exist-' + Date.now()), 3);
    assert.equal(r.purged, 0);
});

test('P7 the harvest save path CALLS the purge (call-site pin, not just behaviour)', () => {
    // Deleting the call would leave every test above green while the hazard
    // returned -- exactly the shape of failure this repo has been bitten by.
    const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'lib', 'registry-manager.js'), 'utf8');
    const at = src.indexOf('async save()');
    assert.ok(at > 0, 'save() must exist');
    const body = src.slice(at);
    assert.match(body, /await purgeStaleLocalShards\(/,
        'save() must call the purge after writing its shards');
    assert.ok(body.indexOf('await purgeStaleLocalShards(') > body.indexOf('Saved ${shardIndex} shards'),
        'the purge must run AFTER the shards are written, never before');
    assert.match(src, /import \{ SHARD_SIZE, purgeStaleLocalShards \} from '\.\/registry-utils\.js';/);
});
