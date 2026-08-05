// Hermetic guard for the D-403 read-only evidence collector.
// NO network, NO credentials, NO R2 access: it exercises the in-process command
// allow-list with locally constructed stand-ins and statically scans the two
// files in the D-403 diff for forbidden mutation constructs.
//
// This file deliberately CONTAINS the forbidden token strings (they are the
// needles it searches for). It scans only TARGETS below, never itself, so the
// needles can never mask a real violation in the collector or the workflow.
//
// Run: node --test scripts/audit/d403-evidence-collector.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAllowedCommand, ALLOWED_R2_COMMANDS } from './d403-evidence-collector.mjs';
import { parseUrls, urlCensus } from './d403-indexnow-supplement.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const COLLECTOR = path.join(HERE, 'd403-evidence-collector.mjs');
const SUPPLEMENT = path.join(HERE, 'd403-indexnow-supplement.mjs');
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'reliability-probe.yml');
const TARGETS = [COLLECTOR, SUPPLEMENT, WORKFLOW];

// Forbidden mutation constructs. Any occurrence in a TARGET is a hard failure.
const FORBIDDEN = [
  'PutObjectCommand', 'DeleteObjectCommand', 'DeleteObjectsCommand', 'CopyObjectCommand',
  'CreateMultipartUploadCommand', 'UploadPartCommand', 'CompleteMultipartUploadCommand',
  'lib-storage', 'r2-workflow-cli', 'wrangler', 'aws s3', 'actions/cache/save',
  'actions/cache@', 'continue-on-error', '|| true', 'set -x', 'printenv',
  'curl ', 'wget ', 'eval(', 'new Function(', 'IfNoneMatch', 'IfMatch',
];

/** Named class stand-ins: the allow-list keys on constructor.name, so these are
 *  indistinguishable from the real SDK commands at the guard boundary. */
function stub(name) {
  const C = { [name]: class { constructor() { this.input = {}; } } }[name];
  return new C();
}

test('allow-list admits exactly the three read-only command classes', () => {
  assert.deepEqual(ALLOWED_R2_COMMANDS, ['ListObjectsV2Command', 'GetObjectCommand', 'HeadObjectCommand']);
  for (const n of ALLOWED_R2_COMMANDS) assert.equal(assertAllowedCommand(stub(n)), n);
});

test('allow-list rejects every write/mutation command class before transmission', () => {
  const denied = [
    'PutObjectCommand', 'DeleteObjectCommand', 'DeleteObjectsCommand', 'CopyObjectCommand',
    'CreateMultipartUploadCommand', 'UploadPartCommand', 'CompleteMultipartUploadCommand',
    'PutBucketLifecycleConfigurationCommand', 'Upload', 'RestoreObjectCommand',
  ];
  for (const n of denied) {
    assert.throws(() => assertAllowedCommand(stub(n)), /R2_COMMAND_DENIED/, `${n} must be denied`);
  }
  assert.throws(() => assertAllowedCommand(null), /R2_COMMAND_DENIED/);
  assert.throws(() => assertAllowedCommand({}), /R2_COMMAND_DENIED/);
});

/** Returns the forbidden needles found in `text`. Shared by the real scan and
 *  the self-check below, so the scan can never be silently vacuous. */
function scan(text) {
  return FORBIDDEN.filter((needle) => text.toLowerCase().includes(needle.toLowerCase()));
}

test('static scan is non-vacuous (it flags a synthetic violation)', () => {
  assert.deepEqual(scan('await s3.send(new PutObjectCommand({}));'), ['PutObjectCommand']);
  assert.deepEqual(scan('uses: actions/cache/save@v5'), ['actions/cache/save']);
  assert.deepEqual(scan('clean text'), []);
});

test('D-403 diff files contain no forbidden mutation construct', () => {
  for (const f of TARGETS) {
    assert.ok(fs.existsSync(f), `missing target ${f}`);
    const hits = scan(fs.readFileSync(f, 'utf8'));
    assert.deepEqual(hits, [], `${path.basename(f)} contains forbidden construct(s): ${hits.join(', ')}`);
  }
});

test('collector imports only read-only SDK commands', () => {
  const src = fs.readFileSync(COLLECTOR, 'utf8');
  const imports = [...src.matchAll(/^import\s+\{([^}]+)\}\s+from\s+'@aws-sdk\/[^']+';$/gm)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim()));
  assert.deepEqual(imports.sort(), ['GetObjectCommand', 'ListObjectsV2Command', 'S3Client']);
  assert.equal(/\bimport\s*\(/.test(src), false, 'dynamic import is forbidden');
  assert.equal(/\brequire\s*\(/.test(src), false, 'require() is forbidden');
});

test('workflow keeps least privilege and never wires a decryption key', () => {
  const yml = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(yml, /permissions:\r?\n\s+contents: read\r?\n/);
  assert.equal(/^\s*(id-token|packages|actions|pull-requests|issues|deployments):\s*write/m.test(yml), false);
  assert.equal(/restore-keys/.test(yml), false, 'prefix-fallback cache lookup is forbidden');
  assert.equal(/AES_CRYPTO_KEY/.test(yml), false, 'shard decryption key must never be wired');
  assert.match(yml, /if-no-files-found: error/);
});

test('supplement is a single-GET, no-cache, no-AES capture of the exact key', () => {
  const src = fs.readFileSync(SUPPLEMENT, 'utf8');
  const imports = [...src.matchAll(/^import\s+\{([^}]+)\}\s+from\s+'@aws-sdk\/[^']+';$/gm)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim()));
  assert.deepEqual(imports.sort(), ['GetObjectCommand', 'S3Client']);
  assert.equal((src.match(/new GetObjectCommand\(/g) || []).length, 1, 'exactly one GetObject');
  assert.equal(/AES_CRYPTO_KEY|initShardCrypto/.test(src), false, 'AES wiring is prohibited here');
  assert.equal(/actions\/cache|readBinaryShard|internal-handoff/.test(src), false, 'no cache or handoff work');
  assert.match(src, /const EXPECTED_KEY = 'state\/indexnow-delta\.json';/);
  assert.match(src, /const EXPECTED_SIZE = 388033;/);
  assert.match(src, /const EXPECTED_SHA256 = 'f88010602321e4b4bcd24caea3076f49a088b89f9c450dac25956ba97c3c2659';/);
  assert.match(src, /const EXPECTED_LAST_MODIFIED = '2026-08-04T08:46:37\.000Z';/);
  assert.match(src, /const NEXT_CYCLE_START = '2026-08-05T05:32:34Z';/);
  // On identity mismatch the body must be discarded, never written as evidence.
  assert.match(src, /PRE_FAILURE_CYCLE_INDEXNOW_SNAPSHOT: 'MISSED'/);
  assert.match(src, /raw_body_preserved: false/);
});

test('supplement parses the producer shape and counts URLs correctly', () => {
  // Producer shape: JSON.stringify(urls) => the document root IS the URL array.
  const root = parseUrls(Buffer.from(JSON.stringify(['https://a/1', 'https://a/2', 'https://a/1'])));
  assert.equal(root.field, '$ (document root array)');
  assert.equal(root.schema, 'root-array-of-url-strings');
  const c = urlCensus(root.list);
  assert.equal(c.total_url_entries, 3);
  assert.equal(c.unique_url_count, 2);
  assert.equal(c.duplicate_url_count, 1);
  assert.equal(c.distinct_urls_seen_more_than_once, 1);
  // Canonical set hash is over the SORTED UNIQUE set, newline joined.
  const expected = crypto.createHash('sha256').update('https://a/1\nhttps://a/2').digest('hex');
  assert.equal(c.canonical_url_set_sha256, expected);
  // Secondary IndexNow wire shape is recognised and named as such.
  const wire = parseUrls(Buffer.from(JSON.stringify({ urlList: ['https://b/1'] })));
  assert.equal(wire.field, 'urlList');
  // Anything else must fail loudly rather than silently yield an empty set.
  assert.throws(() => parseUrls(Buffer.from(JSON.stringify({ nope: 1 }))), /UNRECOGNISED_INDEXNOW_SCHEMA/);
  assert.throws(() => parseUrls(Buffer.from('not json')), /./);
});

test('supplement routes its only R2 call through the shared allow-list', () => {
  const src = fs.readFileSync(SUPPLEMENT, 'utf8');
  assert.match(src, /import \{ assertAllowedCommand \} from '\.\/d403-evidence-collector\.mjs';/);
  assert.match(src, /async function send\(s3, cmd\) \{\r?\n\s*assertAllowedCommand\(cmd\);/);
  assert.equal(/s3\.send\(/.test(src.replace(/return s3\.send\(cmd\);/, '')), false, 'no direct send bypassing the funnel');
});
