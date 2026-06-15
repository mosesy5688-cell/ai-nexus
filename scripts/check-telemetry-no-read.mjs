/**
 * P2 Adoption Telemetry -- NO-READ + BINDING-CONFINEMENT static gate (BLOCKING).
 *
 * (Run via `node scripts/check-telemetry-no-read.mjs`. The leading shebang was
 * removed in TA2: with the added ES-module exports, Vite's SSR transform (used
 * by vitest to import the gate functions for the H-25 mutation proofs) hoists the
 * imports ABOVE a mid-file shebang and then chokes on it. The file is always
 * invoked through `node`, never as a bare executable, so the shebang is moot.)
 *
 * Authority: SPEC s8 (THE INVARIANT: "Telemetry data must never be read by FNI
 * scoring, ranking, search result ordering, entity projection, or MCP response
 * generation"), s8 enforcement (binding-NAME repo-wide confinement; static gate
 * modeled on check-c4-anti-arbitration.mjs with anti-vacuity proof); Founder
 * DISPOSITION D-2026-0615-49 O-5 (MANDATORY/BLOCKING) + the binding-confinement
 * rulings (RUNTIME dereference allowlist = the single write adapter ONLY;
 * TEXTUAL mentions allowed only in wrangler/config + env-type + adapter + mock +
 * static gate + telemetry tests).
 *
 * Three blocking assertions, each with anti-vacuity proof (scanned > 0):
 *  (A) NO-READ: no serve/scoring/projection/ranking/MCP-response path names the
 *      telemetry binding ADOPTION_TELEMETRY at all (it must never be read there).
 *  (B) EMITTER PURITY: the write adapter's public emit() signature accepts NO
 *      Request/URL/Headers/body/raw-path param, and no FORBIDDEN field NAME
 *      appears as an identifier in the telemetry modules.
 *  (C) BINDING CONFINEMENT (GENUINELY REPO-WIDE): the binding name
 *      ADOPTION_TELEMETRY appears ONLY in the textual allowlist (config +
 *      env-type + adapter + mock + this gate + telemetry tests). The scan is
 *      derived from `git ls-files` (the tracked closed set) -- NOT a hand-listed
 *      src/scripts/tests subset -- so .github/workflows, astro.config.*, root
 *      *.ts/js/mjs/cjs/json/toml/yml/yaml, public/, etc. are ALL covered. Only
 *      binary/generated/vendor/build-output/dependency files are excluded. The
 *      RUNTIME dereference of env.ADOPTION_TELEMETRY is allowed ONLY in the single
 *      AE write adapter (the rest of the allowlist is textual-declaration only).
 *      FAIL-CLOSED on: 0 tracked files, 0 scanned text files, or the adapter not
 *      mentioning the binding (confinement-vacuity).
 *
 * Pure Node, one `git ls-files` exec. ASCII-only (CES Art 8.1).
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BINDING = 'ADOPTION_TELEMETRY';
// Word-boundary match so the SPEC document name (..._ADOPTION_TELEMETRY_DESIGN_
// SPEC...) -- where the binding is a substring of a larger identifier -- does NOT
// count as a binding mention. Only the bare binding token is the dereference.
const BINDING_RE = /(?<![A-Za-z0-9_])ADOPTION_TELEMETRY(?![A-Za-z0-9_])/;
const mentionsBinding = (s) => BINDING_RE.test(s);

// (A) NO-READ scanned set = the C4 gate's serve/scoring/ranking paths PLUS the
// SPEC s8-named projection/MCP/search/FNI surfaces. A missing path hard-fails so
// a rename cannot silently drop coverage.
const NO_READ_PATHS = [
  'src/pages/api/v1/select.ts',
  'src/lib/ranking-order.ts',
  'src/pages/api/v1/compare.ts',
  'src/pages/api/v1/badge/[umid].ts',
  'src/pages/api/v1/trends/batch.ts',
  'src/pages/api/v1/concepts.ts',
  'scripts/factory/lib/fni-score.js',
  'src/lib/rationale-builder.ts',
  'src/pages/api/search.ts',
  'src/pages/api/mcp.ts',
  'src/lib/entity-projection.ts',
  'src/lib/cluster-rerank.ts',
  'src/middleware.ts',
  // TA2: the pure classifier is a serve-adjacent module that must NEVER name the
  // binding (it deals only in already-extracted primitives; emit() is elsewhere).
  'src/lib/telemetry/request-classifier.ts',
  // TA2: the route-owned datasets emit site must never name the binding either.
  'src/pages/api/v1/datasets.ts',
];

// (B) TA2 call sites: the instrumented files that invoke emit(). Their emit()
// call argument shape is structurally checked (must be emit(env, <eventVar>) --
// never emit(request..)/emit(...url)/emit(...headers)/raw object literal).
const TA2_CALL_SITES = [
  'src/middleware.ts',
  'src/pages/api/mcp.ts',
  'src/pages/api/v1/datasets.ts',
];

// (C) TEXTUAL allowlist: the ONLY files permitted to mention the binding name.
const TEXTUAL_ALLOWLIST = new Set([
  'wrangler.toml',
  'src/env.d.ts',
  'src/lib/telemetry/ae-adapter.ts',
  'src/lib/telemetry/mock-binding.ts',
  'scripts/check-telemetry-no-read.mjs',
  'tests/srs1/telemetry-isolation.test.ts',
  'tests/srs1/telemetry-schema.test.ts',
  'tests/srs1/telemetry-privacy.test.ts',
  'tests/srs1/INVARIANT_REGISTRY.md',
]);

// (B) emitter-purity: forbidden TYPE/param tokens that must NOT appear in the
// adapter's emit() signature, and forbidden field NAMES that must not be read as
// identifiers anywhere in the telemetry modules (besides the FORBIDDEN_FIELDS
// declaration + comments that explain the ban).
const EMITTER_FORBIDDEN_PARAM_TYPES = ['Request', 'URL', 'Headers'];
const TELEMETRY_MODULES = [
  'src/lib/telemetry/vocab.ts',
  'src/lib/telemetry/schema.ts',
  'src/lib/telemetry/ae-adapter.ts',
  'src/lib/telemetry/mock-binding.ts',
  'src/lib/telemetry/request-classifier.ts',
];

// (B) The pure event-builder module whose exported builders must be typed
// `: TelemetryEvent | null` and whose returned event objects must carry ONLY the
// 8 allowed keys (raw ephemeral inputs like pathname/uaString are allowed as
// LOCAL processing -- the structural checks ban them only as EVENT KEYS / as
// values surfaced in return/error/reason/fallback, never as honest locals).
const CLASSIFIER_MODULE = 'src/lib/telemetry/request-classifier.ts';
const EVENT_ALLOWED_KEYS = [
  'schema_version', 'surface', 'operation', 'status_class',
  'cache_class', 'audience_class', 'referer_host_class', 'time_bucket',
];
// Raw-input identifiers that may be LOCAL processing in the classifier but must
// NEVER appear as an event key or be surfaced raw in a return/reason/fallback.
const RAW_INPUT_TOKENS = ['uaString', 'refererHost', 'pathname', 'rawUa', 'userAgent'];

function read(rel) {
  const abs = path.join(REPO_ROOT, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : null;
}

// ---------------------------------------------------------------------------
// (B) EMITTER PURITY -- structural checks that ACTUALLY CONSUME the telemetry
// modules (D-53 O-6). Each function takes raw source text and returns an array
// of violation strings (empty == pass), so the mutation-proof tests can feed a
// crafted/mutated source and assert the check flips. ASCII-only.
//
// Comments/strings would create false positives (a comment that says "no
// console.*" or "passed to emit()"), so the structural scans first STRIP block
// + line comments. This is a code-shape check, not a comment-prose check.
// ---------------------------------------------------------------------------

/** Remove block comments and line comments (good-enough for scanning TS source
 *  for code shapes; not a full parser, but it never leaves comment prose that
 *  could trip the structural checks). */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** B(1): emit() signature accepts no Request|URL|Headers param type. */
export function checkEmitSignature(adapterSrc) {
  const errs = [];
  const m = adapterSrc.match(/export function emit\(([\s\S]*?)\)\s*:/);
  if (!m) return ['emit() signature not found'];
  const sig = m[1];
  for (const t of EMITTER_FORBIDDEN_PARAM_TYPES) {
    if (new RegExp(`:\\s*${t}\\b`).test(sig)) errs.push(`emit() accepts forbidden param type ${t}`);
  }
  return errs;
}

/** B(2): every exported `buildXEvent` builder is typed `: TelemetryEvent | null`
 *  (the frozen return type only). A builder returning a wider/other type fails. */
export function checkBuilderReturnType(classifierSrcRaw) {
  const classifierSrc = stripComments(classifierSrcRaw);
  const errs = [];
  const re = /export function (build\w*Event)\s*\([\s\S]*?\)\s*:\s*([^{]+)\{/g;
  let mm; let found = 0;
  while ((mm = re.exec(classifierSrc)) !== null) {
    found++;
    const ret = mm[2].replace(/\s+/g, ' ').trim();
    if (!/^TelemetryEvent \| null$/.test(ret)) {
      errs.push(`${mm[1]} return type must be "TelemetryEvent | null", got "${ret}"`);
    }
  }
  if (found === 0) errs.push('no buildXEvent builders found (anti-vacuity)');
  return errs;
}

/** B(3): no FORBIDDEN/raw key name is assigned INTO a returned event object.
 *  We scan the classifier's returned object literals (the body of each builder's
 *  `return { ... }`) and assert every written key is in EVENT_ALLOWED_KEYS and
 *  no raw-input token appears as a key. Honest locals are untouched. */
export function checkReturnedEventKeys(classifierSrcRaw) {
  const classifierSrc = stripComments(classifierSrcRaw);
  const errs = [];
  const re = /return\s*\{([\s\S]*?)\};/g;
  let mm; let scanned = 0;
  while ((mm = re.exec(classifierSrc)) !== null) {
    const objBody = mm[1];
    // Only treat as an EVENT object literal if it sets schema_version (the marker
    // of the frozen event shape) -- avoids flagging unrelated small return objects.
    if (!/\bschema_version\s*:/.test(objBody)) continue;
    scanned++;
    const keyRe = /(^|[,{]\s*)([A-Za-z_]\w*)\s*:/g;
    let km;
    while ((km = keyRe.exec(objBody)) !== null) {
      const key = km[2];
      if (RAW_INPUT_TOKENS.includes(key)) errs.push(`raw-input token "${key}" used as an event key`);
      else if (!EVENT_ALLOWED_KEYS.includes(key)) errs.push(`non-allowed key "${key}" in returned event`);
    }
  }
  if (scanned === 0) errs.push('no returned event object literal found (anti-vacuity)');
  return errs;
}

/** B(4): telemetry modules contain no console.* and no raw-value logging. */
export function checkNoConsole(moduleSrcRaw) {
  const moduleSrc = stripComments(moduleSrcRaw);
  return /\bconsole\s*\./.test(moduleSrc) ? ['console.* present in telemetry module'] : [];
}

/** B(5): a call site never passes a Request/URL/Headers/raw object literal to
 *  emit(); the first emit() argument must be the bare `env` identifier and the
 *  second must be a simple identifier (the event var), not a constructed shape. */
export function checkCallSiteEmit(callSiteSrcRaw) {
  const callSiteSrc = stripComments(callSiteSrcRaw);
  const errs = [];
  const re = /\bemit\s*\(([^)]*)\)/g;
  let mm; let found = 0;
  while ((mm = re.exec(callSiteSrc)) !== null) {
    found++;
    const args = mm[1].split(',').map((s) => s.trim());
    if (args.length < 2) { errs.push(`emit() call has too few args: emit(${mm[1]})`); continue; }
    if (args[0] !== 'env') errs.push(`emit() first arg must be bare "env", got "${args[0]}"`);
    if (!/^[A-Za-z_]\w*$/.test(args[1])) errs.push(`emit() second arg must be a simple event identifier, got "${args[1]}"`);
    if (/\b(request|url|headers|new\s+URL|new\s+Request|new\s+Headers|\{)/i.test(mm[1])) {
      errs.push(`emit() passes a raw Request/URL/Headers/object: emit(${mm[1]})`);
    }
  }
  // found may be 0 for a call site that only defines a recorder; not vacuous here
  // because the aggregate B check asserts >0 emit calls across all call sites.
  return { errs, found };
}

/** B(6): a raw-input token is never surfaced in a return/error/reason/fallback
 *  STRING or thrown value. Honest locals (assignment, function args) are fine; we
 *  only flag a raw token appearing inside a return-string / reason: / throw. */
export function checkNoRawInReturnString(classifierSrc) {
  const errs = [];
  // The string-quote class is built from char codes (39=single, 34=double,
  // 96=backtick) so this source carries NO backtick inside a regex literal --
  // such a backtick is mis-tokenized as a template-literal start by some module
  // loaders. Both regexes here are built via new RegExp(string) for the same
  // reason (no backtick template literals near regex literals in this file).
  const QUOTE = '[' + String.fromCharCode(39, 34, 96) + ']';
  const surfRe = new RegExp('\\breturn\\s+' + QUOTE + '|reason\\s*:\\s*' + QUOTE + '|throw\\s+');
  const lineComment = new RegExp('(^|[^:])//.*$');
  const lines = classifierSrc.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].replace(lineComment, '$1'); // drop trailing line comment
    if (!surfRe.test(ln)) continue;
    for (const tok of RAW_INPUT_TOKENS) {
      const tokRe = new RegExp('(?<![A-Za-z0-9_])' + tok + '(?![A-Za-z0-9_])');
      if (tokRe.test(ln)) {
        errs.push('raw-input token "' + tok + '" surfaced in return/reason/throw at line ' + (i + 1));
      }
    }
  }
  return errs;
}

// (D) MIDDLEWARE SYNC-TELEMETRY invariant (D-53 O-5 critical-path rule): the
// middleware telemetry recorder must be SYNCHRONOUS + NON-BLOCKING so it never
// enters the response-return critical path. Three mutation-provable shapes are
// asserted on the comment-stripped middleware source:
//   (1) NO `await recordTelemetry(` anywhere (telemetry is never awaited).
//   (2) recordTelemetry is declared SYNC: `function recordTelemetry(` with NO
//       leading `async` and NO `Promise<...>` return annotation.
//   (3) NO awaited dynamic env import after next(): no `await import(` survives
//       (the prior awaited getTelemetryEnv design is fully removed).
// Each rule flips on a crafted bad source (a re-introduced `await recordTelemetry`,
// an `async function recordTelemetry`, or an `await import(` re-appears).
export const MIDDLEWARE_MODULE = 'src/middleware.ts';
export function checkMiddlewareSyncTelemetry(middlewareSrcRaw) {
  const src = stripComments(middlewareSrcRaw);
  const errs = [];
  // (1) telemetry is never awaited.
  if (/\bawait\s+recordTelemetry\s*\(/.test(src)) {
    errs.push('middleware awaits recordTelemetry (must be sync, non-blocking)');
  }
  // (2) recordTelemetry declared synchronous (not async, not Promise-returning).
  const decl = src.match(/(\basync\s+)?function\s+recordTelemetry\s*\(([\s\S]*?)\)\s*:\s*([^\{]+)\{/);
  if (!decl) {
    errs.push('recordTelemetry declaration not found (anti-vacuity)');
  } else {
    if (decl[1]) errs.push('recordTelemetry is declared async (must be sync void)');
    const ret = decl[3].replace(/\s+/g, ' ').trim();
    if (/Promise\s*</.test(ret)) errs.push('recordTelemetry returns a Promise (must be sync void), got "' + ret + '"');
  }
  // (3) no awaited dynamic env import left in the middleware (the removed design).
  if (/\bawait\s+import\s*\(/.test(src)) {
    errs.push('middleware still uses await import(...) for env (removed design re-introduced)');
  }
  return errs;
}

// Binary/generated/vendor/build-output/dependency exclusions: a file is EXCLUDED
// from the text scan only if it is one of these (everything else IS scanned, so a
// new text/config/workflow location can never silently escape confinement).
const EXCLUDE_EXT = new Set([
  'wasm', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'pdf', 'zip', 'gz',
  'br', 'zst', 'woff', 'woff2', 'ttf', 'eot', 'db', 'sqlite', 'bin', 'pyc',
  'lock',
]);
const EXCLUDE_PATH_RE = /(^|\/)(node_modules|dist|build|\.astro|coverage|target|vendor|\.git)\//;
const isBinaryLike = (buf) => buf.includes(0); // NUL byte => treat as binary

/**
 * Repo-wide binding scan over the TRACKED closed set (`git ls-files`). Scans every
 * tracked text file for the binding token; excludes only binary/generated/vendor/
 * build-output/dependency files. Returns hits + scan stats for fail-closed checks.
 */
function findBindingMentions() {
  let tracked = [];
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
    tracked = out.toString('utf-8').split('\0').filter(Boolean);
  } catch {
    return { hits: [], filesScanned: 0, trackedCount: 0 };
  }
  const trackedCount = tracked.length;
  const hits = [];
  let filesScanned = 0;
  for (const rel of tracked) {
    if (EXCLUDE_PATH_RE.test('/' + rel + '/')) continue;
    const ext = (rel.split('.').pop() || '').toLowerCase();
    if (rel.includes('.') && EXCLUDE_EXT.has(ext)) continue;
    const abs = path.join(REPO_ROOT, rel);
    let buf;
    try { buf = fs.readFileSync(abs); } catch { continue; }
    if (isBinaryLike(buf)) continue;   // defensive binary guard (no extension)
    filesScanned++;
    if (mentionsBinding(buf.toString('utf-8'))) hits.push(rel);
  }
  return { hits, filesScanned, trackedCount };
}

/**
 * (B) aggregate assertion -- ACTUALLY CONSUMES TELEMETRY_MODULES + the call
 * sites with the structural checks above. Returns { errors[], scanned } so main
 * can fail-closed and so the mutation-proof test can invoke it directly. It is
 * MUTATION-PROVABLE: injecting a raw event key, a console.log(rawUa), or a
 * Headers-typed emit param makes one of the sub-checks return a non-empty array.
 */
export function runAssertionB(readFn = read) {
  const errors = [];
  let scanned = 0;

  // (1) emit() signature.
  const adapter = readFn('src/lib/telemetry/ae-adapter.ts');
  if (adapter === null) errors.push('write adapter missing');
  else { scanned++; for (const e of checkEmitSignature(adapter)) errors.push(e); }

  // Consume EVERY telemetry module: none may contain console.* (4).
  for (const rel of TELEMETRY_MODULES) {
    const src = readFn(rel);
    if (src === null) { errors.push(`telemetry module missing: ${rel}`); continue; }
    scanned++;
    for (const e of checkNoConsole(src)) errors.push(`${rel}: ${e}`);
  }

  // (2)(3)(6) classifier structural purity.
  const classifier = readFn(CLASSIFIER_MODULE);
  if (classifier === null) errors.push(`classifier module missing: ${CLASSIFIER_MODULE}`);
  else {
    scanned++;
    for (const e of checkBuilderReturnType(classifier)) errors.push(`${CLASSIFIER_MODULE}: ${e}`);
    for (const e of checkReturnedEventKeys(classifier)) errors.push(`${CLASSIFIER_MODULE}: ${e}`);
    for (const e of checkNoRawInReturnString(classifier)) errors.push(`${CLASSIFIER_MODULE}: ${e}`);
  }

  // (D) middleware sync-telemetry invariant (D-53 O-5 critical-path rule).
  const middleware = readFn(MIDDLEWARE_MODULE);
  if (middleware === null) errors.push(`middleware module missing: ${MIDDLEWARE_MODULE}`);
  else {
    scanned++;
    for (const e of checkMiddlewareSyncTelemetry(middleware)) errors.push(`${MIDDLEWARE_MODULE}: ${e}`);
  }

  // (5) call-site emit() argument shape; require >0 emit calls overall.
  let totalEmitCalls = 0;
  for (const rel of TA2_CALL_SITES) {
    const src = readFn(rel);
    if (src === null) { errors.push(`call site missing: ${rel}`); continue; }
    scanned++;
    const { errs, found } = checkCallSiteEmit(src);
    totalEmitCalls += found;
    for (const e of errs) errors.push(`${rel}: ${e}`);
  }
  if (totalEmitCalls === 0) errors.push('anti-vacuity: no emit() call found across TA2 call sites');

  return { errors, scanned };
}

function main() {
  console.log('[TEL] Adoption-Telemetry no-read + binding-confinement static gate');
  let failed = false;
  let totalScanned = 0;
  let totalLines = 0;

  // (A) NO-READ
  const missing = [];
  let noReadFiles = 0;
  const noReadViolations = [];
  for (const rel of NO_READ_PATHS) {
    const src = read(rel);
    if (src === null) { missing.push(rel); continue; }
    noReadFiles++;
    const lines = src.split('\n');
    totalLines += lines.length;
    lines.forEach((ln, i) => {
      if (mentionsBinding(ln)) noReadViolations.push(`${rel}:${i + 1}`);
    });
  }
  totalScanned += noReadFiles;
  console.log(`[TEL] (A) no-read paths scanned: ${noReadFiles}/${NO_READ_PATHS.length}`);
  if (missing.length) {
    console.error(`[TEL] FAIL (A): ${missing.length} no-read path(s) missing: ${missing.join(', ')}`);
    failed = true;
  }
  if (noReadViolations.length) {
    console.error(`[TEL] FAIL (A): telemetry binding read in serve/scoring path(s): ${noReadViolations.join(', ')}`);
    failed = true;
  }

  // (B) EMITTER PURITY -- structural, consuming TELEMETRY_MODULES + call sites.
  const b = runAssertionB();
  totalScanned += b.scanned;
  console.log(`[TEL] (B) emitter-purity structural checks: ${b.scanned} module(s)/call-site(s) scanned`);
  if (b.scanned === 0) {
    console.error('[TEL] FAIL (B): scanned 0 modules -- assertion B vacuous.'); failed = true;
  }
  if (b.errors.length) {
    console.error(`[TEL] FAIL (B): ${b.errors.join(' | ')}`); failed = true;
  } else {
    console.log('[TEL] (B) emitter pure: signature clean; builders TelemetryEvent|null; '
      + 'returned events 8-key only; no console.*; call sites emit(env, event); no raw surfacing.');
  }

  // (C) BINDING CONFINEMENT -- genuinely repo-wide over `git ls-files`.
  const { hits, filesScanned, trackedCount } = findBindingMentions();
  totalScanned += filesScanned;
  const leaks = hits.filter((h) => !TEXTUAL_ALLOWLIST.has(h));
  console.log(`[TEL] (C) tracked files: ${trackedCount}; text files scanned: ${filesScanned}; binding mentions: ${hits.length}`);
  if (leaks.length) {
    console.error(`[TEL] FAIL (C): binding named outside textual allowlist: ${leaks.join(', ')}`);
    failed = true;
  }

  // FAIL-CLOSED: 0 tracked files (not a git repo / ls-files failed) or 0 scanned
  // text files means the confinement scan is vacuous -- treat as a hard failure.
  if (trackedCount === 0) {
    console.error('[TEL] FAIL: 0 tracked files (git ls-files empty/failed) -- confinement vacuous.');
    failed = true;
  }
  if (filesScanned === 0) {
    console.error('[TEL] FAIL: 0 text files scanned -- confinement vacuous.');
    failed = true;
  }

  // ANTI-VACUITY: prove the gate actually scanned (A) targets too.
  if (totalScanned === 0 || totalLines === 0) {
    console.error('[TEL] FAIL: scanned 0 files/lines -- gate is vacuous (paths moved?).');
    failed = true;
  }
  // Prove (C) confined to a NON-EMPTY allowlist that DID match (the adapter -- the
  // sole RUNTIME-dereference site -- must be among the mentions) else vacuous.
  if (!hits.includes('src/lib/telemetry/ae-adapter.ts')) {
    console.error('[TEL] FAIL: anti-vacuity -- write adapter does not mention the binding; confinement vacuous.');
    failed = true;
  }
  console.log(`[TEL] anti-vacuity: total scanned=${totalScanned}, no-read lines=${totalLines}, tracked=${trackedCount}, binding mentions=${hits.length}`);

  if (failed) process.exit(1);
  console.log('[TEL] PASS: no serve path reads telemetry; emitter pure; binding confined.');
}

export {
  NO_READ_PATHS, TEXTUAL_ALLOWLIST, findBindingMentions, BINDING,
  TELEMETRY_MODULES, TA2_CALL_SITES, CLASSIFIER_MODULE, EVENT_ALLOWED_KEYS,
  RAW_INPUT_TOKENS,
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
