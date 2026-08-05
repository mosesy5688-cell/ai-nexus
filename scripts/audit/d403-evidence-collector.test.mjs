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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAllowedCommand, ALLOWED_R2_COMMANDS } from './d403-evidence-collector.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const COLLECTOR = path.join(HERE, 'd403-evidence-collector.mjs');
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'reliability-probe.yml');
const TARGETS = [COLLECTOR, WORKFLOW];

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

test('workflow keeps least privilege and exact-key restore only', () => {
  const yml = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(yml, /permissions:\r?\n\s+contents: read\r?\n/);
  assert.equal(/^\s*(id-token|packages|actions|pull-requests|issues|deployments):\s*write/m.test(yml), false);
  assert.equal(/restore-keys/.test(yml), false, 'restore-keys is forbidden (exact keys only)');
  assert.match(yml, /key: global-registry-29963927733/);
  assert.match(yml, /key: r2-upload-manifest-30802427780-30815518168/);
  assert.match(yml, /if-no-files-found: error/);
});
