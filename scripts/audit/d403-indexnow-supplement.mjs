#!/usr/bin/env node
// D-403 SUPPLEMENT: preserve the RAW BODY of the pre-failure-cycle IndexNow
// delta before the running Factory 1/4 cycle overwrites it. The PRE artifact
// kept only the digest, so the URL difference set could not be recomputed.
//
// Exactly ONE GetObject against ONE hardcoded key. It restores no GHA cache, it
// does not touch the immutable handoffs, and it wires no shard-decryption key.
// Read-only enforcement is the SAME single source of truth as the PRE
// collector: assertAllowedCommand rejects any non LIST/GET/HEAD command class
// BEFORE the command reaches the transport. Write command classes are neither
// imported nor constructible here. No mutation of any kind, no rerun, no retry.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { assertAllowedCommand } from './d403-evidence-collector.mjs';

const BUCKET = 'ai-nexus-assets';
const OUT_DIR = 'd403-indexnow-evidence';
const REPORT = 'report.json';
const PKG_MANIFEST = 'package-manifest.json';
const RAW_BODY = 'indexnow-delta.raw.json';
const URL_SET = 'url-set.json.gz';

// Hardcoded expected identity of the PRE-failure-cycle object.
const EXPECTED_KEY = 'state/indexnow-delta.json';
const EXPECTED_SIZE = 388033;
const EXPECTED_SHA256 = 'f88010602321e4b4bcd24caea3076f49a088b89f9c450dac25956ba97c3c2659';
const EXPECTED_LAST_MODIFIED = '2026-08-04T08:46:37.000Z';
const NEXT_CYCLE_START = '2026-08-05T05:32:34Z';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const nowUtc = () => new Date().toISOString();
const write = (name, buf) => fs.writeFileSync(path.join(OUT_DIR, name), buf);

/** Single funnel: the allow-list runs before transmission. */
async function send(s3, cmd) {
  assertAllowedCommand(cmd);
  return s3.send(cmd);
}

function client() {
  const accountId = process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  return new S3Client({
    region: 'auto', endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
}

async function getExactObject(s3) {
  const at = nowUtc();
  try {
    const r = await send(s3, new GetObjectCommand({ Bucket: BUCKET, Key: EXPECTED_KEY }));
    const chunks = [];
    for await (const c of r.Body) chunks.push(Buffer.from(c));
    const body = Buffer.concat(chunks);
    return {
      observed: {
        key: EXPECTED_KEY, present: true, retrieved_utc: at, size: body.length, sha256: sha256(body),
        etag: String(r.ETag || '').replace(/"/g, ''), content_type: r.ContentType || null,
        content_length: typeof r.ContentLength === 'number' ? r.ContentLength : null,
        last_modified: r.LastModified ? new Date(r.LastModified).toISOString() : null,
        metadata: r.Metadata || {},
      },
      body,
    };
  } catch (e) {
    return { observed: { key: EXPECTED_KEY, present: false, retrieved_utc: at, error_name: e && e.name ? e.name : 'Error' }, body: null };
  }
}

/** The producer writes JSON.stringify(urls): the document ROOT is the URL array
 *  (scripts/factory/lib/indexnow-delta.js), and the consumer asserts
 *  Array.isArray (scripts/factory/indexnow-push.js). The IndexNow wire shape
 *  {"urlList": [...]} is accepted as a secondary form and named as such. */
export function parseUrls(body) {
  const doc = JSON.parse(body.toString('utf8'));
  if (Array.isArray(doc)) return { field: '$ (document root array)', schema: 'root-array-of-url-strings', list: doc };
  if (doc && Array.isArray(doc.urlList)) return { field: 'urlList', schema: 'object-with-urlList-array', list: doc.urlList };
  throw new Error('UNRECOGNISED_INDEXNOW_SCHEMA: root is neither a URL array nor an object with a urlList array');
}

export function urlCensus(list) {
  const counts = new Map();
  let nonString = 0;
  for (const u of list) {
    if (typeof u !== 'string') { nonString += 1; continue; }
    counts.set(u, (counts.get(u) || 0) + 1);
  }
  const unique = [...counts.keys()].sort();
  return {
    total_url_entries: list.length,
    non_string_entries: nonString,
    unique_url_count: unique.length,
    duplicate_url_count: list.length - nonString - unique.length,
    distinct_urls_seen_more_than_once: [...counts.values()].filter((n) => n > 1).length,
    canonical_url_set_sha256: sha256(unique.join('\n')),
    canonical_url_set_member: URL_SET,
    unique,
  };
}

function writePackage(report) {
  report.completed_utc = nowUtc();
  write(REPORT, Buffer.from(JSON.stringify(report, null, 1)));
  const files = fs.readdirSync(OUT_DIR).filter((f) => f !== PKG_MANIFEST).sort();
  const pkg = {
    generated_utc: nowUtc(),
    files: files.map((f) => ({ name: f, size: fs.statSync(path.join(OUT_DIR, f)).size, sha256: sha256(fs.readFileSync(path.join(OUT_DIR, f))) })),
  };
  pkg.package_sha256 = sha256(Buffer.from(JSON.stringify(pkg.files)));
  write(PKG_MANIFEST, Buffer.from(JSON.stringify(pkg, null, 1)));
  return pkg.package_sha256;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { observed, body } = await getExactObject(client());
  const report = {
    schema: 'd403-indexnow-supplement/1', collector_mode: 'READ_ONLY_SINGLE_GET',
    started_utc: nowUtc(), next_cycle_start_utc: NEXT_CYCLE_START,
    shard_decryption_key_wired: false,
    expected: { key: EXPECTED_KEY, size: EXPECTED_SIZE, sha256: EXPECTED_SHA256, last_modified: EXPECTED_LAST_MODIFIED },
    observed,
    run: {
      repository: process.env.GITHUB_REPOSITORY || null, run_id: process.env.GITHUB_RUN_ID || null,
      run_attempt: process.env.GITHUB_RUN_ATTEMPT || null, event_name: process.env.GITHUB_EVENT_NAME || null,
      branch_ref: process.env.GITHUB_REF || null, branch_commit_sha: process.env.GITHUB_SHA || null,
      base_sha: process.env.D403_BASE_SHA || null,
    },
  };
  const fieldMatch = {
    present: observed.present === true,
    size: observed.size === EXPECTED_SIZE,
    sha256: observed.sha256 === EXPECTED_SHA256,
    last_modified: observed.last_modified === EXPECTED_LAST_MODIFIED,
  };
  report.identity_field_match = fieldMatch;
  const identityMatch = Object.values(fieldMatch).every(Boolean);

  if (!identityMatch) {
    // The object was already replaced by the new cycle. The replacement body is
    // NOT preserved and NOT attributed to the failed cycle.
    report.summary = {
      PRE_FAILURE_CYCLE_INDEXNOW_SNAPSHOT: 'MISSED',
      raw_body_preserved: false,
      replacement_body_attribution: 'NOT_ATTRIBUTED_TO_FAILED_CYCLE',
      mismatched_fields: Object.keys(fieldMatch).filter((k) => !fieldMatch[k]),
      note: 'expected vs observed metadata recorded above; body deliberately discarded; no rerun',
    };
    const digest = writePackage(report);
    console.log(`[D403-SUPP] PRE_FAILURE_CYCLE_INDEXNOW_SNAPSHOT=MISSED package_sha256=${digest}`);
    return 0;
  }

  // Exact identity: preserve the raw bytes as an artifact member FIRST, so the
  // body survives even if parsing then fails.
  write(RAW_BODY, body);
  report.raw_body = {
    member: RAW_BODY, size: body.length, sha256: sha256(body),
    byte_identical_to_expected: body.length === EXPECTED_SIZE && sha256(body) === EXPECTED_SHA256,
    retrieval_utc: observed.retrieved_utc,
  };

  let parsed;
  try {
    parsed = parseUrls(body);
  } catch (e) {
    report.parse_failure = { error: e && e.message ? e.message : String(e), raw_body_preserved: true };
    report.summary = {
      PRE_FAILURE_CYCLE_INDEXNOW_SNAPSHOT: 'CAPTURED',
      raw_body_preserved: true, url_set_derived: false,
      note: 'exact-identity body preserved; parsing failed; failing closed without rerun',
    };
    const digest = writePackage(report);
    console.error(`[D403-SUPP] PARSE_FAILED (raw body preserved) package_sha256=${digest}`);
    return 1;
  }

  const census = urlCensus(parsed.list);
  const { unique, ...censusFields } = census;
  write(URL_SET, zlib.gzipSync(Buffer.from(JSON.stringify(unique))));
  report.parsed = {
    schema: parsed.schema,
    authoritative_url_field: parsed.field,
    authoritative_field_provenance: 'producer scripts/factory/lib/indexnow-delta.js writes JSON.stringify(urls); consumer scripts/factory/indexnow-push.js asserts Array.isArray',
    ...censusFields,
    retrieval_utc: observed.retrieved_utc,
  };
  report.summary = {
    PRE_FAILURE_CYCLE_INDEXNOW_SNAPSHOT: 'CAPTURED',
    raw_body_preserved: true, url_set_derived: true,
    authoritative_url_field: parsed.field,
    total_url_entries: censusFields.total_url_entries,
    unique_url_count: censusFields.unique_url_count,
    duplicate_url_count: censusFields.duplicate_url_count,
    canonical_url_set_sha256: censusFields.canonical_url_set_sha256,
  };
  const digest = writePackage(report);
  console.log(`[D403-SUPP] CAPTURED urls=${censusFields.unique_url_count} package_sha256=${digest}`);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('d403-indexnow-supplement.mjs')) {
  main().then((code) => { process.exit(code); }).catch((e) => {
    console.error(`[D403-SUPP] FAILED: ${e.message}`);
    process.exit(1);
  });
}
