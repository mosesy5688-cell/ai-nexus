// OP-GR-B shared TEST FIXTURES (ruling D-2026-0810-418).
//
// Not a suite -- it declares no tests and is deliberately named without
// `.test.` so the CI registration guard does not enumerate it. It exists so the
// run and verification suites can share one set of real NXVF fixtures instead
// of duplicating them (both files are held to the 250-line house standard).
//
// Every fixture is built by the repo's OWN ShardWriter. Callers must set a
// SYNTHETIC AES_CRYPTO_KEY before importing; the production key is never used.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HeadObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { ShardWriter } from './lib/shard-writer.js';
import { GIANT_MIN_BYTES } from './lib/registry-renorm-core.js';

export const GIANT_ID = 'kaggle-dataset--synthetic--giant';
export const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
export const smallRec = (id) => JSON.stringify({ id, source: 'kaggle', type: 'dataset', name: id, tags: ['a', 'b'] });
export const censusOf = (ids) => ({
    count: ids.length, forensics_sha256: 'test', matches_layer: 'registry',
    records: ids.map((id) => ({ id })),
});

/** A real over-bound record: a raw Kaggle Tag-DTO array, as the corpus stores it. */
export function giantRec(id, targetBytes = GIANT_MIN_BYTES + 1024 * 1024) {
    const one = (i) => `{"ref":"t${i}","name":"tag-${i}","nameNullable":"tag-${i}","hasName":true,` +
        `"description":"d${i}","hasDescription":true,"fullPath":"p/t${i}","hasFullPath":true,` +
        `"competitionCount":0,"datasetCount":0,"scriptCount":0,"totalCount":0}`;
    const head = `{"id":"${id}","source":"kaggle","type":"dataset","name":"g","tags":[`;
    const parts = [head];
    let n = 0, size = head.length;
    while (size < targetBytes) { const s = (n ? ',' : '') + one(n); parts.push(s); size += s.length; n++; }
    parts.push(']}');
    return parts.join('');
}

/**
 * A record over the bound for a reason the contract CANNOT fix: a huge
 * NON-governed field. `tags` is still projected (so the record is governed and
 * reconciles normally), but the record stays >= 32 MiB afterwards, so the
 * post-transform verification must fail. This is a REAL reachable shape -- the
 * contract governs only `tags`, and nothing promises a record is oversized for
 * that reason alone.
 */
export function unfixableGiant(id) {
    const dtos = Array.from({ length: 200 }, (_, i) => ({ ref: `t${i}`, name: `tag-${i}`, hasName: true }));
    return JSON.stringify({
        id, source: 'kaggle', type: 'dataset', name: 'u',
        body_content: 'q'.repeat(GIANT_MIN_BYTES + 512 * 1024),
        tags: dtos,
    });
}

/** Write a one-shard NXVF registry from JSON texts. Returns the shard path. */
export async function buildRegistry(dir, texts) {
    fs.mkdirSync(dir, { recursive: true });
    const w = new ShardWriter(dir, 'part');
    await w.init();
    w.shardId = 0;
    w.open();
    for (const t of texts) w.writeEntity(Buffer.from(t, 'utf8'));
    w.finalize();
    return path.join(dir, 'part-000.bin');
}

/**
 * Fake R2. `marker` null => absent; object => present; headError => unreadable.
 * Records every PutObjectCommand so a test can assert ZERO writes.
 */
export function fakeS3({ marker = null, headError = null } = {}) {
    const notFound = () => { const e = new Error('NotFound'); e.name = 'NotFound'; e.$metadata = { httpStatusCode: 404 }; throw e; };
    return {
        puts: [],
        async send(cmd) {
            if (cmd instanceof HeadObjectCommand) { if (headError) throw headError; return marker ? {} : notFound(); }
            if (cmd instanceof GetObjectCommand) { return marker ? { Body: [Buffer.from(JSON.stringify(marker))] } : notFound(); }
            if (cmd instanceof PutObjectCommand) { this.puts.push({ Key: cmd.input.Key, bytes: cmd.input.Body.length }); return {}; }
            throw new Error(`unexpected command ${cmd.constructor.name}`);
        },
    };
}
