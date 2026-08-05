// D-403 POST: shared READ-ONLY R2 helpers.
//
// Every R2 call funnels through send(), which applies the SAME allow-list as the
// PRE collector (one source of truth) and throws before the command reaches the
// transport. Only S3Client + ListObjectsV2Command + GetObjectCommand are
// imported; no write/copy/delete/multipart command class is constructible here.
// Large bodies stream straight to disk so a 1.17 GB archive is never buffered.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { assertAllowedCommand } from './d403-evidence-collector.mjs';

export const BUCKET = 'ai-nexus-assets';
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const setHash = (lines) => sha256([...lines].sort().join('\n'));
export const nowUtc = () => new Date().toISOString();

export function makeClient() {
  const accountId = process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  return new S3Client({
    region: 'auto', endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
}

/** Single funnel: the allow-list runs before transmission. */
export async function send(s3, cmd) {
  assertAllowedCommand(cmd);
  return s3.send(cmd);
}

/** Complete (fully paginated) prefix inventory, canonically ordered. */
export async function listPrefix(s3, prefix) {
  const members = [];
  let token;
  do {
    const r = await send(s3, new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, MaxKeys: 1000, ContinuationToken: token }));
    for (const o of r.Contents || []) {
      members.push({
        key: o.Key, size: o.Size, etag: String(o.ETag || '').replace(/"/g, ''),
        last_modified: o.LastModified ? new Date(o.LastModified).toISOString() : null,
      });
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  members.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    prefix, member_count: members.length, inventory: members,
    inventory_set_hash: setHash(members.map((m) => `${m.key} ${m.size} ${m.etag}`)),
    retrieved_utc: nowUtc(),
  };
}

/** Inventory-before / inventory-after torn-capture detection for one prefix. */
export function classifyTorn(before, after) {
  return {
    prefix: before.prefix,
    classification: before.inventory_set_hash === after.inventory_set_hash ? 'COHERENT' : 'CONCURRENTLY_MUTATED',
    before_member_count: before.member_count,
    after_member_count: after.member_count,
  };
}

/** GET a small object fully into memory (manifests, deltas, single shards). */
export async function getObject(s3, key) {
  const at = nowUtc();
  try {
    const r = await send(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const chunks = [];
    for await (const c of r.Body) chunks.push(Buffer.from(c));
    const body = Buffer.concat(chunks);
    return {
      key, present: true, retrieved_utc: at, size: body.length, sha256: sha256(body),
      etag: String(r.ETag || '').replace(/"/g, ''),
      last_modified: r.LastModified ? new Date(r.LastModified).toISOString() : null,
      content_type: r.ContentType || null, metadata: r.Metadata || {}, body,
    };
  } catch (e) {
    return { key, present: false, retrieved_utc: at, error_name: e && e.name ? e.name : 'Error', body: null };
  }
}

/** Strip the body before a record goes into the report. */
export const strip = (o) => ({ ...o, body: undefined });

/**
 * GET a large object by STREAMING it to disk while hashing in flight, so a
 * multi-gigabyte archive never lands in the heap.
 */
export async function getObjectToFile(s3, key, destPath) {
  const at = nowUtc();
  try {
    const r = await send(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const tap = async function* (src) {
      for await (const c of src) { hash.update(c); bytes += c.length; yield c; }
    };
    await pipeline(r.Body, tap, fs.createWriteStream(destPath));
    return {
      key, present: true, retrieved_utc: at, path: destPath, size: bytes, sha256: hash.digest('hex'),
      etag: String(r.ETag || '').replace(/"/g, ''),
      last_modified: r.LastModified ? new Date(r.LastModified).toISOString() : null,
    };
  } catch (e) {
    return { key, present: false, retrieved_utc: at, path: destPath, error_name: e && e.name ? e.name : 'Error' };
  }
}
