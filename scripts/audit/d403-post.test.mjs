// Hermetic guard + behavioural tests for the D-403 POST collector.
// NO network, NO credentials, NO R2, NO AES key: shards are built in-process and
// decoded with encryption inactive. This file deliberately contains the
// forbidden token strings (it is the needle list); it scans only TARGETS, never
// itself. The needle list is duplicated from the PRE guard on purpose so each
// guard fails independently rather than sharing a single point of failure.
//
// Run: node --test scripts/audit/d403-post.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeRegistryDir, IDENTITY_FIELD, parseHeader } from './d403-registry-decode.mjs';
import { idToDeltaUrl } from './d403-post-collect.mjs';
import { relations, classifyU, originMap, promotionByteClose, diff, inter } from './d403-setops.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'reliability-probe.yml');
const MODULES = ['d403-post-collect.mjs', 'd403-r2-read.mjs', 'd403-registry-decode.mjs', 'd403-setops.mjs', 'd403-handoff.mjs'].map((f) => path.join(HERE, f));
const TARGETS = [...MODULES, WORKFLOW];

const FORBIDDEN = [
  'PutObjectCommand', 'DeleteObjectCommand', 'DeleteObjectsCommand', 'CopyObjectCommand',
  'CreateMultipartUploadCommand', 'UploadPartCommand', 'CompleteMultipartUploadCommand',
  'lib-storage', 'r2-workflow-cli', 'wrangler', 'aws s3', 'actions/cache/save',
  'actions/cache/delete', 'continue-on-error', '|| true', 'set -x', 'printenv',
  'curl ', 'wget ', 'eval(', 'new Function(', 'restore-keys',
];
const scan = (text) => FORBIDDEN.filter((n) => text.toLowerCase().includes(n.toLowerCase()));

/** Build a real NXVF shard: header, offset table, then raw JSON payloads. */
function buildShard(rows) {
  const payloads = rows.map((r) => Buffer.from(JSON.stringify(r)));
  const tableOffset = 29;
  let cursor = tableOffset + payloads.length * 8;
  const table = Buffer.alloc(payloads.length * 8);
  payloads.forEach((p, i) => {
    table.writeUInt32LE(cursor, i * 8);
    table.writeUInt32LE(p.length, i * 8 + 4);
    cursor += p.length;
  });
  let checksum = 0;
  for (let i = 0; i < table.length; i += 4) checksum ^= table.readUInt32LE(i);
  const header = Buffer.alloc(29);
  header.write('4e585646', 0, 'hex');
  header.writeUInt8(4, 4);
  header.writeUInt16LE(0, 5);
  header.writeUInt32LE(tableOffset, 7);
  header.writeUInt32LE(payloads.length, 11);
  header.writeUInt32LE(checksum >>> 0, 15);
  return Buffer.concat([header, table, ...payloads]);
}

function shardDir(shards) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd403t-'));
  shards.forEach((rows, i) => fs.writeFileSync(path.join(dir, `part-${String(i).padStart(3, '0')}.bin`), buildShard(rows)));
  return dir;
}

test('static scan is non-vacuous and POST files carry no forbidden construct', () => {
  assert.deepEqual(scan('new PutObjectCommand({})'), ['PutObjectCommand']);
  assert.deepEqual(scan('uses: actions/cache/save@v5'), ['actions/cache/save']);
  assert.deepEqual(scan('clean'), []);
  for (const f of TARGETS) {
    assert.ok(fs.existsSync(f), `missing ${f}`);
    assert.deepEqual(scan(fs.readFileSync(f, 'utf8')), [], `${path.basename(f)} has a forbidden construct`);
  }
});

test('POST modules import only read-only SDK commands and never dynamic-import', () => {
  const src = MODULES.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const imports = [...src.matchAll(/^import\s+\{([^}]+)\}\s+from\s+'@aws-sdk\/[^']+';$/gm)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim()));
  assert.deepEqual(imports.sort(), ['GetObjectCommand', 'ListObjectsV2Command', 'S3Client']);
  assert.equal(/\bimport\s*\(/.test(src), false);
  assert.equal(/\brequire\s*\(/.test(src), false);
});

test('AES key is wired ONLY in the POST collector step and never printed', () => {
  const yml = fs.readFileSync(WORKFLOW, 'utf8');
  const hits = yml.split(/\r?\n/).filter((l) => l.includes('AES_CRYPTO_KEY'));
  assert.equal(hits.length, 1, 'AES_CRYPTO_KEY must appear exactly once');
  assert.match(hits[0], /^ {10}AES_CRYPTO_KEY: \$\{\{ secrets\.AES_CRYPTO_KEY \}\}$/);
  // It must sit inside the POST collector step, not any other step.
  const step = yml.slice(yml.indexOf('- name: Collect D-403 post-cycle evidence'));
  const block = step.slice(0, step.indexOf('- name: Verify evidence package completeness'));
  assert.ok(block.includes('AES_CRYPTO_KEY'), 'AES must be scoped to the collector step');
  // Never echoed, never interpolated into a shell command.
  assert.equal(/echo[^\n]*AES_CRYPTO_KEY/.test(yml), false);
  assert.equal(/\$AES_CRYPTO_KEY|\$\{AES_CRYPTO_KEY\}/.test(yml), false);
  const src = MODULES.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  assert.equal(/console\.[a-z]+\([^\n]*AES_CRYPTO_KEY/.test(src), false, 'key must never be logged');
});

test('identity field is the single authoritative `id` with no fallback chain', () => {
  assert.equal(IDENTITY_FIELD, 'id');
  const src = fs.readFileSync(path.join(HERE, 'd403-registry-decode.mjs'), 'utf8');
  assert.equal(/canonical_id\s*\|\|/.test(src), false, 'no canonical_id fallback');
  assert.equal(/umid\s*\|\|/.test(src), false, 'no umid fallback');
  assert.equal(/entity_id\s*\|\|/.test(src), false, 'no entity_id fallback');
  assert.match(src, /row\[IDENTITY_FIELD\]/);
});

test('id -> delta URL mirrors the producer (absolute URL, not a bare path)', () => {
  // Regression: getRouteFromId returns a PATH. Comparing that against the
  // delta's ABSOLUTE urls silently matched nothing, making every delta
  // intersection a false zero. The origin must be prepended.
  const url = idToDeltaUrl('arxiv:2512.07814v1', 'paper');
  assert.equal(url, 'https://free2aitools.com/paper/2512.07814v1');
  assert.ok(url.startsWith('https://'), 'must be an absolute URL');
  assert.equal(idToDeltaUrl('hf-dataset:foo/bar', 'dataset'), 'https://free2aitools.com/dataset/foo/bar');
  // A probe over a realistic delta set must actually hit.
  const deltaSet = new Set([url]);
  assert.equal(deltaSet.has(idToDeltaUrl('arxiv:2512.07814v1', 'paper')), true);
});

test('NXVF header parses and a clean registry decodes COMPLETE', () => {
  const dir = shardDir([[{ id: 'a', type: 'model' }, { id: 'b', type: 'model' }], [{ id: 'c', type: 'paper' }]]);
  const head = parseHeader(fs.readFileSync(path.join(dir, 'part-000.bin')));
  assert.equal(head.entityCount, 2);
  const { evidence, ids } = decodeRegistryDir('T', dir, {});
  assert.equal(evidence.status, 'COMPLETE');
  assert.equal(evidence.total_header_rows, 3);
  assert.equal(evidence.total_decoded_rows, 3);
  assert.equal(evidence.unique_identity_cardinality, 3);
  assert.ok(evidence.shards.every((s) => s.rows_match));
  assert.deepEqual([...ids].sort(), ['a', 'b', 'c']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('duplicate rows are counted separately from unique cardinality', () => {
  const dir = shardDir([[{ id: 'a' }, { id: 'a' }, { id: 'b' }]]);
  const { evidence } = decodeRegistryDir('T', dir, {});
  assert.equal(evidence.total_decoded_rows, 3);
  assert.equal(evidence.unique_identity_cardinality, 2);
  assert.equal(evidence.repeated_distinct_identity_count, 1);
  assert.equal(evidence.excess_duplicate_row_count, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a row without the identity field fails the registry closed', () => {
  const dir = shardDir([[{ id: 'a' }, { name: 'no-id-here' }]]);
  const { evidence } = decodeRegistryDir('T', dir, {});
  assert.equal(evidence.status, 'FAILED_CLOSED');
  assert.equal(evidence.missing_identity_rows, 1);
  assert.ok(evidence.reasons.some((r) => r.startsWith('ROWS_WITHOUT_IDENTITY_FIELD')));
  assert.equal(evidence.usable_as_complete_set, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an undecodable shard can never present an empty set as valid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd403t-'));
  fs.writeFileSync(path.join(dir, 'part-000.bin'), Buffer.from('not an nxvf shard at all'));
  const { evidence } = decodeRegistryDir('T', dir, {});
  assert.equal(evidence.status, 'FAILED_CLOSED');
  assert.equal(evidence.usable_as_complete_set, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('set algebra and U classification cover every member exactly once', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'd403o-'));
  const P = { ids: new Set(['a', 'b']), complete: true };
  const F = { ids: new Set(['a', 'b', 'c', 'd', 'e']), complete: true };
  const H = { ids: new Set(['a', 'b', 'c', 'd']), complete: true };
  assert.deepEqual(diff(F.ids, P.ids), ['c', 'd', 'e']);
  assert.deepEqual(inter(F.ids, H.ids), ['a', 'b', 'c', 'd']);
  const rel = relations(out, { P, F, H });
  assert.deepEqual(rel.U, ['c', 'd', 'e']);
  assert.equal(rel.evidence.relations.F_minus_P.count, 3);
  assert.equal(rel.evidence.relations.U_minus_H.count, 1);
  // c re-announced; d carried forward but with fewer populated fields; e dropped.
  const summary = classifyU(out, rel.U, H, new Set(['c']), new Map([['d', 9]]), new Map([['d', 4]]));
  assert.equal(summary.buckets.REHARVESTED_AND_MERGED.count, 1);
  assert.equal(summary.buckets.CARRIED_FORWARD_BUT_INCOMPLETE.count, 1);
  assert.equal(summary.buckets.DROPPED_FROM_NEXT_OUTPUT.count, 1);
  assert.equal(summary.buckets.IDENTITY_CHANGED.count, 0);
  assert.equal(summary.every_member_classified_exactly_once, true);
  fs.rmSync(out, { recursive: true, force: true });
});

test('U classification degrades to EVIDENCE_UNAVAILABLE when H is incomplete', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'd403o-'));
  const H = { ids: new Set(['a']), complete: false };
  const summary = classifyU(out, ['a', 'b'], H, new Set(), null, null);
  assert.equal(summary.buckets.EVIDENCE_UNAVAILABLE.count, 2);
  assert.equal(summary.every_member_classified_exactly_once, true);
  fs.rmSync(out, { recursive: true, force: true });
});

test('origin map attributes parts by exact sha256 identity', () => {
  const map = originMap(
    [{ name: 'part-001.bin', sha256: 'aa' }, { name: 'part-002.bin', sha256: 'bb' }, { name: 'part-003.bin', sha256: 'cc' }],
    [{ name: 'part-001.bin', sha256: 'aa' }],
    new Map([['part-002.bin', 'bb']]),
  );
  assert.equal(map.rows[0].origin, 'CACHE_29963927733');
  assert.equal(map.rows[1].origin, 'PUBLICATION_COMMITTED_R2');
  assert.equal(map.rows[2].origin, 'OTHER');
  assert.equal(map.tally.CACHE_29963927733, 1);
});

test('promotion byte-close reports identity and asserts no cause', () => {
  const same = promotionByteClose(new Map([['part-632.bin', 'x']]), [{ name: 'part-632.bin', sha256: 'x' }], ['part-632.bin']);
  assert.equal(same.verdict, 'BYTE_IDENTICAL_ALL_PARTS');
  assert.equal(same.parts_identical, 1);
  assert.match(same.interpretation_policy, /NO causal claim/);
  const differ = promotionByteClose(new Map([['part-632.bin', 'x']]), [{ name: 'part-632.bin', sha256: 'y' }], ['part-632.bin']);
  assert.equal(differ.verdict, 'NOT_BYTE_IDENTICAL');
  const missing = promotionByteClose(new Map(), [], ['part-632.bin']);
  assert.equal(missing.verdict, 'UNDECIDABLE_MISSING_EVIDENCE');
  assert.equal(crypto.createHash('sha256').update('').digest('hex').length, 64);
});
