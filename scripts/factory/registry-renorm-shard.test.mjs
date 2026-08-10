// OP-GR-B (ruling D-2026-0810-418): NXVF shard access under a TEST key.
//
// Every fixture here is built by the repo's OWN ShardWriter, so what is under
// test is the real container and the real AES-256-CTR layer, not a mock of
// them. The key is a synthetic constant defined in this file; the production
// AES_CRYPTO_KEY is never read, never needed, and never present.
//
// The load-bearing claim this suite pins: a rewrite changes the bytes of the
// records it is asked to change AND NOTHING ELSE. Because the IV is
// offset-derived, every record after the first edit is re-encrypted, so
// "untouched" has to be proven at the DECOMPRESSED TEXT layer, which is exactly
// what these tests compare.
//
// HERMETIC: throwaway tmpdir, no network, no credentials, no R2.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AES_CRYPTO_KEY = 'a'.repeat(64); // synthetic test key -- NOT production

const { ShardWriter } = await import('./lib/shard-writer.js');
const { zstdCompressSync, zstdCompress } = await import('./lib/zstd-helper.js');
const shardMod = await import('./lib/registry-renorm-shard.js');
const { initCrypto, readShardIndex, entityIsGiant, entityText, rewriteShard, zstdContentSize, zstdSizeBound, entityCountOf } = shardMod;

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ogb-shard-'));

/** Build a real NXVF shard from JSON texts, via the pipeline's own writer. */
async function buildShard(dir, shardId, texts) {
    fs.mkdirSync(dir, { recursive: true });
    const w = new ShardWriter(dir, 'part');
    await w.init();
    w.shardId = shardId;
    w.open();
    for (const t of texts) w.writeEntity(Buffer.from(t, 'utf8'));
    w.finalize();
    return path.join(dir, `part-${String(shardId).padStart(3, '0')}.bin`);
}

const rec = (id, filler = 0) => JSON.stringify({
    id, source: 'kaggle', type: 'dataset', name: id.split('--').pop(),
    tags: filler ? Array.from({ length: filler }, (_, i) => ({ ref: `t${i}`, name: `t${i}`, hasName: true })) : ['a', 'b'],
});

test('crypto is active under the test key (otherwise the whole suite is vacuous)', () => {
    assert.equal(initCrypto(), true, 'AES must be enabled for these fixtures to mean anything');
});

test('S1 fixture payloads really are encrypted at rest (no plaintext Zstd magic)', async () => {
    const dir = tmpdir();
    try {
        initCrypto();
        const file = await buildShard(dir, 0, [rec('kaggle-dataset--x--a'), rec('kaggle-dataset--x--b')]);
        const shard = readShardIndex(file);
        assert.equal(shard.checksumOk, true);
        const raw = shard.data.subarray(shard.entries[0].offset, shard.entries[0].offset + shard.entries[0].size);
        assert.equal(raw.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])), false,
            'stored payload must not be readable plaintext Zstd -- it is AES-CTR encrypted');
        // ...and the module can still read it back.
        assert.equal((await entityText(shard, shard.entries[0])).toString('utf8'), rec('kaggle-dataset--x--a'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S2 zstdContentSize is EXACT when declared, and null rather than wrong when not', async () => {
    await zstdCompress(Buffer.from('init'));
    // This repo's writer declares FCS only on the small/WASM path. The large
    // path (native zstd binary) emits FCS_flag=0, Single_Segment=0 -- no size.
    // Both behaviours are pinned so a codec swap that changes them goes RED
    // here rather than silently degrading the scan.
    let declared = 0, undeclared = 0;
    for (const n of [1, 100, 5000, 200000, 400000]) {
        const text = Buffer.from(JSON.stringify({ pad: 'z'.repeat(n) }), 'utf8');
        const got = zstdContentSize(zstdCompressSync(text, 3));
        if (got === null) undeclared++;
        else { declared++; assert.equal(got, text.length, `declared size must be exact for ${text.length} B`); }
    }
    assert.ok(declared > 0, 'some frames must declare a size (else S2 proves nothing)');
    assert.ok(undeclared > 0, 'the undeclared path must exist -- it is why zstdSizeBound is needed');
});

test('S2b zstdContentSize returns null (not a wrong number) on a non-Zstd buffer', () => {
    assert.equal(zstdContentSize(Buffer.from('{"id":"plain"}', 'utf8')), null);
    assert.equal(zstdContentSize(Buffer.alloc(2)), null);
});

test('S2c zstdSizeBound never UNDER-states the true decompressed size', async () => {
    await zstdCompress(Buffer.from('init'));
    for (const n of [1, 100, 5000, 200000, 400000, 1500000]) {
        const text = Buffer.from(JSON.stringify({ pad: 'z'.repeat(n) }), 'utf8');
        const bound = zstdSizeBound(zstdCompressSync(text, 3));
        assert.notEqual(bound, null, `bound must be computable for ${text.length} B`);
        assert.ok(bound >= text.length,
            `bound ${bound} must not under-state ${text.length} -- under-stating would SKIP a real giant`);
    }
});

test('S2e A1: a MULTI-FRAME payload is refused, never bounded from its first frame', async () => {
    await zstdCompress(Buffer.from('init'));
    const a = zstdCompressSync(Buffer.from(JSON.stringify({ pad: 'z'.repeat(5000) })), 3);
    const b = zstdCompressSync(Buffer.from(JSON.stringify({ pad: 'y'.repeat(5000) })), 3);

    assert.notEqual(zstdSizeBound(a), null, 'control: a single frame must still bound');
    assert.equal(zstdSizeBound(Buffer.concat([a, b])), null,
        'two concatenated frames decompress to the SUM; bounding from frame 1 would UNDER-state and could skip a giant');
    // A trailing byte the walk cannot account for is equally refused.
    assert.equal(zstdSizeBound(Buffer.concat([a, Buffer.from([0x00])])), null);
});

test('S2d a small record is dismissed by the bound alone (the scan affordability claim)', async () => {
    await zstdCompress(Buffer.from('init'));
    const small = Buffer.from(rec('kaggle-dataset--x--small'), 'utf8');
    const bound = zstdSizeBound(zstdCompressSync(small, 3));
    assert.ok(bound < 32 * 1024 * 1024,
        'an ordinary registry record must be ruled out without decompression');
});

test('S3 entityIsGiant classifies both sides of the bound and reports its path', async () => {
    const dir = tmpdir();
    try {
        initCrypto();
        const small = rec('kaggle-dataset--x--a');
        const big = JSON.stringify({ id: 'kaggle-dataset--x--big', source: 'kaggle', type: 'dataset', pad: 'z'.repeat(300000) });
        const file = await buildShard(dir, 3, [small, big]);
        const shard = readShardIndex(file);

        const a = await entityIsGiant(shard, shard.entries[0], 32 * 1024 * 1024);
        assert.equal(a.giant, false);
        assert.ok(['frame-header', 'block-bound'].includes(a.probed), 'a small record must not be decompressed');

        // Same record, threshold BELOW its size: it must now be reported giant,
        // which proves the classifier reads real bytes and is not size-blind.
        const b = await entityIsGiant(shard, shard.entries[1], 1024);
        assert.equal(b.giant, true);
        assert.equal(b.bytes, Buffer.byteLength(big, 'utf8'), 'the reported size must be the true one');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S4 rewriteShard replaces ONLY the named records, byte-exact elsewhere', async () => {
    const dir = tmpdir();
    try {
        initCrypto();
        const texts = [
            rec('kaggle-dataset--x--keep0'), rec('kaggle-dataset--x--edit', 50),
            rec('kaggle-dataset--x--keep1'), rec('kaggle-dataset--x--keep2'),
        ];
        const file = await buildShard(dir, 7, texts);
        const replacement = JSON.stringify({ id: 'kaggle-dataset--x--edit', source: 'kaggle', type: 'dataset', tags: ['t0'] });

        const out = await rewriteShard(file, path.join(dir, 'staged'), new Map([[1, Buffer.from(replacement, 'utf8')]]));
        assert.equal(out.entityCount, 4, 'record count is invariant');
        assert.equal(out.replaced, 1);

        fs.renameSync(out.outPath, file);
        const after = readShardIndex(file);
        assert.equal(after.header.entityCount, 4);
        assert.equal(after.checksumOk, true, 'rewritten offset table must self-verify');
        assert.equal(after.header.slotId, 7, 'slot id must survive the rewrite');

        const got = [];
        for (const e of after.entries) got.push((await entityText(after, e)).toString('utf8'));
        assert.equal(got[0], texts[0], 'untouched record 0 must be byte-identical');
        assert.equal(got[2], texts[2], 'untouched record 2 must be byte-identical');
        assert.equal(got[3], texts[3], 'untouched record 3 must be byte-identical');
        assert.equal(got[1], replacement, 'the named record must carry the new bytes');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S5 rewriteShard is fail-closed when a replacement index does not exist', async () => {
    const dir = tmpdir();
    try {
        initCrypto();
        const file = await buildShard(dir, 1, [rec('kaggle-dataset--x--a'), rec('kaggle-dataset--x--b')]);
        await assert.rejects(
            () => rewriteShard(file, path.join(dir, 'staged'), new Map([[99, Buffer.from('{}')]])),
            /OP_GR_B_REPLACEMENT_MISS/,
            'a replacement that never landed must throw, not be silently dropped');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S5b A3: a shard whose written name would differ from its own is refused', async () => {
    const dir = tmpdir();
    try {
        initCrypto();
        // `part-7.bin` is a REAL reachable shape: the regex accepts it, but
        // ShardWriter zero-pads to `part-007.bin`. The filename feeds the IV, so
        // writing under a different name yields a shard nothing can decrypt.
        const built = await buildShard(dir, 7, [rec('kaggle-dataset--x--a')]);
        const unpadded = path.join(dir, 'part-7.bin');
        fs.renameSync(built, unpadded);
        await assert.rejects(
            () => rewriteShard(unpadded, path.join(dir, 'staged'), new Map()),
            /OP_GR_B_SHARD_NAME_MISMATCH/,
            'an IV-load-bearing name drift must throw, not silently produce an undecryptable shard');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S6 entityCountOf reads the container count without decoding entities', async () => {
    const dir = tmpdir();
    try {
        initCrypto();
        const file = await buildShard(dir, 2, [rec('a'), rec('b'), rec('c')]);
        assert.equal(entityCountOf(file), 3);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S7 a non-NXVF file is rejected loudly, never parsed as one', async () => {
    const dir = tmpdir();
    try {
        const bogus = path.join(dir, 'part-000.bin');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(bogus, Buffer.from('not an nxvf shard at all'));
        assert.throws(() => readShardIndex(bogus), /OP_GR_B_NOT_NXVF/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
