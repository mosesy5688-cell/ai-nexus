import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
// @ts-ignore — JS ESM module (no .d.ts); tested for its runtime contract.
import { sha256File, discoverServedArtifacts, buildCycleManifest, emitCycleManifest } from '../../scripts/factory/lib/pack-finalizer.js';

// Vitest-collected hermetic suite for the R5 Phase-2 cycle-manifest emit in
// pack-finalizer.js. Uses a real temp dir of fixture artifacts (no network, no
// sqlite). Converted 1:1 from scripts/factory/pack-finalizer-cycle-manifest.test.mjs.

const sha = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');

function makeShardDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r5-pf-'));
    const bytes: Record<string, Buffer> = {};
    const write = (rel: string, body: Buffer) => {
        const p = path.join(dir, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, body);
        bytes[rel.replace(/\\/g, '/')] = body;
    };
    // meta shards + fused + required singletons + reader anchors + rankings + term_index/* + cluster-ann/*
    write('meta-00.db', Buffer.from('META0'));
    write('meta-01.db', Buffer.from('META1'));
    write('meta-02.db', Buffer.from('META2'));
    write('fused-shard-000.bin', Buffer.from('FUSED0'));
    write('fused-shard-001.bin', Buffer.from('FUSED1'));
    write('id-index.bin', Buffer.from('IDINDEX'));
    write('hot-shard.bin', Buffer.from('HOT'));
    write('vector-core.bin', Buffer.from('VEC'));
    write('meta-knowledge.db', Buffer.from('KNOW'));      // reader anchor singleton
    write('meta-report.db', Buffer.from('REPORT'));       // reader anchor singleton
    write('rankings-model.db', Buffer.from('RANKMODEL')); // rankings-<group>.db
    write('term_index/000.bin', Buffer.from('TERM0'));
    write('term_index/nested/001.bin', Buffer.from('TERM1'));
    write('cluster-ann-0.bin', Buffer.from('CANN0'));
    // decoys that must NOT be enumerated
    write('shards_manifest.json', Buffer.from('{"legacy":true}'));
    write('scratch.tmp', Buffer.from('IGNORE'));
    return { dir, bytes };
}

describe('pack-finalizer — R5 cycle-manifest emit', () => {
    it('(PF1) discoverServedArtifacts finds every served class + recurses; drops non-served', () => {
        const { dir } = makeShardDir();
        const logicals = discoverServedArtifacts(dir).map((a: any) => a.logical);
        for (const l of ['meta-00.db', 'meta-01.db', 'meta-02.db', 'fused-shard-000.bin', 'fused-shard-001.bin',
            'id-index.bin', 'hot-shard.bin', 'vector-core.bin', 'meta-knowledge.db', 'meta-report.db', 'rankings-model.db',
            'term_index/000.bin', 'term_index/nested/001.bin', 'cluster-ann-0.bin']) {
            expect(logicals.includes(l)).toBe(true);
        }
        expect(logicals.includes('shards_manifest.json')).toBe(false);
        expect(logicals.includes('scratch.tmp')).toBe(false);
    });

    it('(PF2 / integrity triple) each blob key === sha256 of its local bytes', () => {
        const { dir, bytes } = makeShardDir();
        const cm = buildCycleManifest({ buildId: 'run-1-a1-deadbeef', partitions: { meta_shards: 3 }, artifacts: discoverServedArtifacts(dir) });
        for (const [logical, key] of Object.entries(cm.blobs) as [string, string][]) {
            expect(key).toBe(sha(bytes[logical]));
            expect(key).toBe(sha256File(path.join(dir, logical)));
        }
        expect(cm.build_id).toBe('run-1-a1-deadbeef');
        expect(cm.partitions).toStrictEqual({ meta_shards: 3 });
    });

    it('(PF3) emitCycleManifest writes cycles/<buildId>/manifest.json enumerating all served artifacts', async () => {
        const { dir, bytes } = makeShardDir();
        const cm = await emitCycleManifest(dir, 'run-9-a2-cafebabe0000', { meta_shards: 3, total_entities: 5 });
        const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'cycles', 'run-9-a2-cafebabe0000', 'manifest.json'), 'utf8'));
        expect(onDisk).toStrictEqual(cm);
        expect(Object.keys(cm.blobs).length).toBe(Object.keys(bytes).length - 2); // minus the 2 decoys
        expect(cm.partitions.total_entities).toBe(5);
    });

    it('(PF4) emit does NOT modify shards_manifest.json (legacy manifest byte-identical)', async () => {
        const { dir } = makeShardDir();
        const before = fs.readFileSync(path.join(dir, 'shards_manifest.json'));
        await emitCycleManifest(dir, 'run-2-a1-0000', { meta_shards: 3 });
        const after = fs.readFileSync(path.join(dir, 'shards_manifest.json'));
        expect(before.equals(after)).toBe(true);
    });

    it('(PF5 / RED-restore) mutating one blob byte changes ONLY that key (content-address is real)', () => {
        const { dir } = makeShardDir();
        const base = buildCycleManifest({ buildId: 'b', partitions: { meta_shards: 3 }, artifacts: discoverServedArtifacts(dir) });
        fs.writeFileSync(path.join(dir, 'meta-01.db'), Buffer.from('META1-MUTATED')); // real mutation
        const after = buildCycleManifest({ buildId: 'b', partitions: { meta_shards: 3 }, artifacts: discoverServedArtifacts(dir) });
        expect(after.blobs['meta-01.db']).not.toBe(base.blobs['meta-01.db']);
        expect(after.blobs['meta-00.db']).toBe(base.blobs['meta-00.db']);
    });
});
