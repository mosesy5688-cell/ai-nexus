// V25.8.3 R2 Handoff — Reusable backup/restore for inter-workflow data. D-380: unified application-layer
// retry + error classification + SINGLE-client lifecycle for the PUT/GET/manifest transport path.
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { createR2Client, fetchR2Etags } from './r2-helpers.js';
import { isUploadEligible } from './upload-eligibility.js';
import { PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

const BUCKET = process.env.R2_BUCKET || 'ai-nexus-assets';
const CT = { '.json': 'application/json', '.zst': 'application/zstd', '.gz': 'application/gzip', '.db': 'application/x-sqlite3', '.bin': 'application/octet-stream', '.ndjson': 'application/x-ndjson', '.tar': 'application/x-tar' };
const contentTypeFor = (key) => CT[path.extname(key).toLowerCase()] || 'application/octet-stream';
const md5 = (d) => crypto.createHash('md5').update(d).digest('hex');
const TRANSIENT = ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ECONNREFUSED', 'ENOTFOUND'];

// D-380 §A classifier. RETRYABLE: timeouts; transport (ECONNRESET/ETIMEDOUT/EPIPE/EAI_AGAIN); HTTP 408/429/5xx;
// SDK-retryable; a GET Body-stream interruption; an OPAQUE empty-message error with NO 4xx evidence. NOT retryable:
// 401/403; 404/NoSuchKey; any other 4xx; manifest JSON parse; eligibility/path/traversal/local-FS/programming.
export function classifyR2Error(e) {
    const name = e?.name || '', code = e?.code || e?.Code || '', httpStatus = e?.$metadata?.httpStatusCode ?? e?.httpStatusCode;
    const base = { retryable: false, terminal: 'terminal', name, code, httpStatus };
    if (httpStatus === 401 || httpStatus === 403) return { ...base, terminal: 'auth' };
    if (name === 'NoSuchKey' || name === 'NotFound' || httpStatus === 404) return { ...base, terminal: 'not_found' };
    if (e instanceof SyntaxError) return { ...base, terminal: 'parse' };
    if (e?.nonRetryable === true) return { ...base, terminal: 'non_retryable' };
    if (e?.retryableStream === true) return { ...base, retryable: true, terminal: 'stream_interrupt' };
    if (name === 'TimeoutError' || name === 'RequestTimeout' || code === 'RequestTimeout' || TRANSIENT.includes(code) || TRANSIENT.includes(name)) return { ...base, retryable: true, terminal: 'transport' };
    if (httpStatus === 408 || httpStatus === 429 || (httpStatus >= 500 && httpStatus <= 599)) return { ...base, retryable: true, terminal: 'http_' + httpStatus };
    if (e?.$retryable) return { ...base, retryable: true, terminal: 'sdk_retryable' };
    if (httpStatus >= 400 && httpStatus < 500) return { ...base, terminal: 'http_' + httpStatus };
    if (!String(e?.message || '').trim() && !httpStatus) return { ...base, retryable: true, terminal: 'opaque_transport' };
    return base;
}

// D-380 §A retry core: up to 4 application-layer attempts; attempts 2-4 use full-jitter backoff, caps [250,500,1000]ms,
// TOTAL wait cap 1750ms. One redacted log line per failed attempt (NEVER credentials/signed-URLs/secrets). AWS SDK
// global maxAttempts is untouched. Non-retryable => terminate immediately (0 further attempts).
async function withR2Retry(fn, { op, key }) {
    const CAPS = [250, 500, 1000], MAX = 4; let waited = 0;
    for (let attempt = 1; attempt <= MAX; attempt++) {
        try { return await fn(); }
        catch (e) {
            const c = classifyR2Error(e); e.r2class = c;
            console.error(`[R2-HANDOFF] ${op} ${key} attempt ${attempt}/${MAX} name=${c.name || '?'} code=${c.code || '?'} http=${c.httpStatus ?? '?'} sdkAttempts=${e?.$metadata?.attempts ?? '?'} sdkDelay=${e?.$metadata?.totalRetryDelay ?? '?'} class=${c.terminal}/${c.retryable ? 'retryable' : 'terminal'}`);
            if (!c.retryable || attempt === MAX) throw e;
            let delay = Math.floor(Math.random() * CAPS[attempt - 1]);
            if (waited + delay > 1750) delay = Math.max(0, 1750 - waited);
            waited += delay; if (delay > 0) await new Promise(r => setTimeout(r, delay));
        }
    }
}

// D-380 §B: direction-explicit wrappers over the shared retry core. The SAME buffer/contentType replay on every PUT retry.
const putObjectWithClient = (client, key, buffer, contentType) => withR2Retry(() => client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType })), { op: 'PUT', key });
async function getBufferWithClient(client, key, op = 'GET') {
    return withR2Retry(async () => {
        const resp = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        const chunks = []; for await (const c of resp.Body) chunks.push(c);
        const data = Buffer.concat(chunks);
        // D-382 Gap 3: ANY short read against a known ContentLength is a retryable premature-EOF truncation
        // (drop the *0.9 tolerance). This throws BEFORE getObjectWithClient writes to disk / counts a restore.
        if (resp.ContentLength && data.length < resp.ContentLength) { const e = new Error(`truncated ${key} (${data.length}/${resp.ContentLength}B)`); e.retryableStream = true; throw e; }
        return data;
    }, { op, key });
}
async function getObjectWithClient(client, key, localPath) {
    const data = await getBufferWithClient(client, key);
    await fs.mkdir(path.dirname(localPath), { recursive: true }); await fs.writeFile(localPath, data);
    return { size: data.length };
}

/** Backup a single local file to R2 (own single client for API compat; retry+classification via putObjectWithClient). */
export async function backupFileToR2(localPath, r2Key, opts = {}) {
    const s3 = createR2Client();
    if (!s3) { console.warn('[R2-HANDOFF] No R2 credentials. Skipping backup.'); return { success: false }; }
    try {
        const data = await fs.readFile(localPath);
        // V27.63 guard extracted into the shared PURE isUploadEligible (D-262 A3): minSize maps to minBytes.
        const { eligible, reason } = isUploadEligible(localPath, data, { minBytes: opts.minSize, requiredJson: opts.requiredJson });
        if (!eligible) { console.error(`[R2-HANDOFF] BLOCKED: ${localPath} ${reason}. Refusing upload to prevent state wipe.`); return { success: false, reason: 'integrity_check_failed' }; }
        await putObjectWithClient(s3, r2Key, data, contentTypeFor(r2Key));
        return { success: true, size: data.length };
    } catch (e) {
        console.error(`[R2-HANDOFF] Backup failed for ${r2Key}: ${e.message || e.name || e.r2class?.terminal || 'unknown'}`);
        if (opts.fatal) throw e;
        return { success: false };
    }
}

/** Restore a single file from R2 to a local path (own single client; retry+classification via getObjectWithClient). */
export async function restoreFileFromR2(r2Key, localPath, opts = {}) {
    const s3 = createR2Client();
    if (!s3) { console.warn('[R2-HANDOFF] No R2 credentials. Skipping restore.'); return { success: false }; }
    try {
        const { size } = await getObjectWithClient(s3, r2Key, localPath);
        return { success: true, size };
    } catch (e) {
        console.error(`[R2-HANDOFF] Restore failed for ${r2Key}: ${e.message || e.name || e.r2class?.terminal || 'unknown'}`);
        if (opts.fatal) throw e;
        return { success: false };
    }
}

/**
 * Backup a local directory to R2. ATOMIC (D-356) + three-state (D-359): _manifest.json COMMIT RECORD is PUT LAST
 * on the SAME client, built ONLY from ELIGIBLE verified members; a POLICY_EXCLUDED file (a NON-.zst member the
 * min-size guard refuses) is NEITHER failure NOR verified; a corrupt .zst still fails LOUD. Eligibility computed ONCE.
 * @returns {{ success, count, totalSize, verified, expected, eligibleExpected, failed, skipped, policyExcluded, committed }}
 */
export async function backupDirectoryToR2(localDir, r2Prefix, opts = {}) {
    const s3 = createR2Client();
    if (!s3) { console.warn('[R2-HANDOFF] No R2 credentials. Skipping directory backup.'); return { success: false, count: 0, totalSize: 0, verified: 0, expected: 0, eligibleExpected: 0, failed: 0, skipped: 0, policyExcluded: 0, committed: false, reason: 'no_credentials' }; }
    const { concurrency = 5, extensions = null, requiredJson = false } = opts;
    const files = await walkDir(localDir, extensions);
    const expected = files.length;
    // Fail-closed default (D-356 #7): empty input is NOT a silent no-op. Best-effort call-sites opt out via shell `|| true`.
    if (expected === 0) { console.warn(`[R2-HANDOFF] No files in ${localDir} (fail-closed empty)`); return { success: false, count: 0, totalSize: 0, verified: 0, expected: 0, eligibleExpected: 0, failed: 0, skipped: 0, policyExcluded: 0, committed: false, empty: true, reason: 'empty_input' }; }
    const r2Etags = await fetchR2Etags(s3, BUCKET, r2Prefix).catch(() => new Map());
    console.log(`[R2-HANDOFF] Incremental backup: ${expected} local, ${r2Etags.size} on R2`);
    let uploaded = 0, skipped = 0, failed = 0, policyExcluded = 0, totalSize = 0;
    const verifiedRel = []; // ATOMIC (D-356): ONLY confirmed relPaths enter here; manifest is PUT strictly LAST.
    for (let i = 0; i < files.length; i += concurrency) {
        const results = await Promise.allSettled(files.slice(i, i + concurrency).map(async (relPath) => {
            const rel = relPath.replace(/\\/g, '/'), localPath = path.join(localDir, relPath), r2Key = r2Prefix + rel;
            const data = await fs.readFile(localPath); // read ONCE; eligibility computed ONCE (D-380 §D).
            const elig = isUploadEligible(localPath, data, { requiredJson });
            if (elig.eligible && r2Etags.get(r2Key) === md5(data)) return { rel, skipped: true }; // etag-identity skip (D-356 #3)
            // D-359: a NON-.zst known-integrity-blocked member => policy-excluded; a corrupt .zst fails LOUD (throw=failed).
            if (!elig.eligible) { if (!rel.endsWith('.zst')) return { rel, policyExcluded: true }; throw new Error(`corrupt .zst upload refused: ${rel} (${elig.reason})`); }
            await putObjectWithClient(s3, r2Key, data, contentTypeFor(r2Key)); // retry-exhausted/terminal throws => failed
            return { rel, size: data.length };
        }));
        for (const r of results) {
            if (r.status !== 'fulfilled') { failed++; continue; }
            if (r.value.policyExcluded) { policyExcluded++; continue; }
            verifiedRel.push(r.value.rel);
            r.value.skipped ? skipped++ : (uploaded++, totalSize += r.value.size);
        }
    }
    const verified = verifiedRel.length;
    // COMMIT GATE (D-356 + D-359): all-excluded => eligibleExpected 0 => fail-closed. Partial/any failure => NO manifest.
    const eligibleExpected = expected - policyExcluded;
    if (eligibleExpected === 0 || verified !== eligibleExpected || failed > 0) { console.error(`[R2-HANDOFF] INCOMPLETE: ${verified}/${eligibleExpected} eligible verified, ${failed} failed, ${policyExcluded} policy-excluded -- manifest NOT written (fail-closed).`); return { success: false, count: uploaded, totalSize, verified, expected, eligibleExpected, failed, skipped, policyExcluded, committed: false, reason: eligibleExpected === 0 ? 'no_eligible_files' : 'partial_upload' }; }
    const manifestBody = JSON.stringify({ files: verifiedRel, timestamp: new Date().toISOString(), count: verifiedRel.length });
    let committed = false;
    // Manifest PUT is strictly LAST, on the SAME s3, through the shared retry core (D-380 §D).
    try { await putObjectWithClient(s3, r2Prefix + '_manifest.json', Buffer.from(manifestBody), 'application/json'); committed = true; }
    catch (e) { console.error(`[R2-HANDOFF] Manifest PUT failed: ${e.message || e.name || e.r2class?.terminal || 'unknown'}`); }
    if (!committed) { console.error(`[R2-HANDOFF] MANIFEST WRITE FAILED (${verifiedRel.length} entries) -- backup NOT committed.`); return { success: false, count: uploaded, totalSize, verified, expected, eligibleExpected, failed, skipped, policyExcluded, committed: false, reason: 'manifest_write_failed' }; }
    console.log(`[R2-HANDOFF] Directory backup COMMITTED: ${uploaded} new + ${skipped} unchanged / ${eligibleExpected} eligible (${policyExcluded} policy-excluded) (${(totalSize / 1024 / 1024).toFixed(1)}MB uploaded)`);
    return { success: true, count: uploaded, totalSize, verified, expected, eligibleExpected, failed, skipped, policyExcluded, committed: true };
}

/**
 * Restore a directory from R2. D-380 §E: SINGLE client for manifest GET + LIST + all object GETs. Manifest 404 =
 * confirmed absent; a timeout/5xx/permission after retries is NOT "absent" (never falls through to LIST). A found
 * manifest is VALIDATED then restored member-for-member (NO orphan/LIST supplementation).
 * @param {object} opts { concurrency=5, strict=false }
 * @returns {{ success, count, expected, restored, missing, failed, manifestFound, source }}
 */
export async function restoreDirectoryFromR2(r2Prefix, localDir, opts = {}) {
    const s3 = createR2Client();
    const R = (success, o = {}) => ({ success, count: o.restored || 0, expected: o.expected || 0, restored: o.restored || 0, missing: o.missing || [], failed: o.failed || [], manifestFound: !!o.manifestFound, source: o.source || 'manifest', ...(o.reason ? { reason: o.reason } : {}) });
    if (!s3) { console.warn('[R2-HANDOFF] No R2 credentials. Skipping directory restore.'); return R(false, { source: 'none', reason: 'no_credentials' }); }
    const { concurrency = 5, strict = false } = opts;
    const restoreEach = async (keys, prefix) => {
        const restored = new Set(), failedArr = [];
        for (let i = 0; i < keys.length; i += concurrency) {
            await Promise.all(keys.slice(i, i + concurrency).map(async (rel) => {
                try { await getObjectWithClient(s3, prefix + rel, path.join(localDir, rel)); restored.add(rel); } catch { failedArr.push(rel); }
            }));
        }
        return { restored, failedArr };
    };
    // 1. Manifest GET via the shared retry/classifier.
    let manifest = null, manifestFound = false;
    try {
        const buf = await getBufferWithClient(s3, r2Prefix + '_manifest.json', 'GET-MANIFEST');
        try { manifest = JSON.parse(buf.toString('utf-8')); manifestFound = true; }
        catch { console.error(`[R2-HANDOFF] Manifest parse failed for ${r2Prefix}`); return R(false, { manifestFound: true, reason: 'manifest_parse_failed' }); }
    } catch (e) {
        const cls = e.r2class || classifyR2Error(e);
        if (cls.terminal !== 'not_found') { console.error(`[R2-HANDOFF] Manifest GET failed for ${r2Prefix}: ${cls.terminal} (NOT treated as absent)`); return R(false, { reason: 'manifest_get_failed' }); }
    }
    if (manifestFound) {
        // D-382 Gap 4a: a valid-JSON `null` / non-object / array manifest must fail-closed STRUCTURED (never throw
        // on `manifest.files`). Only after this guard is it safe to read `.files` + run member validation.
        if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) { console.error(`[R2-HANDOFF] Manifest not an object for ${r2Prefix} -- fail-closed.`); return R(false, { manifestFound: true, reason: 'manifest_invalid', expected: 0 }); }
        const list = manifest.files;
        const base = path.resolve(localDir);
        const unsafe = !Array.isArray(list) || list.length === 0 || manifest.count !== list.length || new Set(list).size !== list.length
            || list.some((f) => typeof f !== 'string' || path.isAbsolute(f) || f.split(/[\\/]/).includes('..') || (path.resolve(localDir, f) !== base && !path.resolve(localDir, f).startsWith(base + path.sep)));
        if (unsafe) { console.error(`[R2-HANDOFF] Manifest INVALID for ${r2Prefix} (structure/dup/abs/traversal) -- fail-closed.`); return R(false, { manifestFound: true, expected: Array.isArray(list) ? list.length : 0, reason: 'manifest_invalid' }); }
        console.log(`[R2-HANDOFF] Manifest found: ${list.length} files. Restoring to ${localDir}...`);
        const { restored, failedArr } = await restoreEach(list, r2Prefix);
        const missing = list.filter((f) => !restored.has(f));
        const success = list.length > 0 && restored.size === list.length && missing.length === 0 && failedArr.length === 0;
        if (!success) console.error(`[R2-HANDOFF] INCOMPLETE: restored ${restored.size}/expected ${list.length}, missing ${missing.length}`);
        return R(success, { expected: list.length, restored: restored.size, missing, failed: failedArr, manifestFound: true, source: 'manifest' });
    }
    // 2. Manifest CONFIRMED ABSENT (404). Strict => fail immediately, NO LIST bypass.
    if (strict) { console.error(`[R2-HANDOFF] Manifest absent for ${r2Prefix} and --strict set -- fail-closed (no LIST fallback).`); return R(false, { manifestFound: false, reason: 'manifest_required_strict' }); }
    // Non-strict: paginated ContinuationToken LIST fallback.
    console.log(`[R2-HANDOFF] No manifest for ${r2Prefix}. Listing (fallback)...`);
    const keys = []; let token;
    // D-382 Gap 4b: LIST retry-exhaustion returns STRUCTURED fail-closed (never throws to the caller).
    try {
        do {
            const resp = await withR2Retry(() => s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: r2Prefix, MaxKeys: 1000, ContinuationToken: token })), { op: 'LIST', key: r2Prefix });
            for (const o of resp.Contents || []) { const rel = o.Key.slice(r2Prefix.length); if (!o.Key.endsWith('_manifest.json') && !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes('..')) keys.push(rel); }
            token = resp.NextContinuationToken;
        } while (token);
    } catch (e) {
        const cls = e.r2class || classifyR2Error(e);
        console.error(`[R2-HANDOFF] LIST fallback failed for ${r2Prefix}: ${cls.terminal} (retry-exhausted) -- fail-closed.`);
        return R(false, { manifestFound: false, source: 'list-fallback', reason: 'list_failed' });
    }
    if (keys.length === 0) { console.warn(`[R2-HANDOFF] No files found under ${r2Prefix}`); return R(false, { manifestFound: false, source: 'list-fallback', reason: 'empty_prefix' }); }
    const { restored, failedArr } = await restoreEach(keys, r2Prefix);
    const missing = keys.filter((k) => !restored.has(k));
    // D-382 Gap 4b: EXPLICIT list-fallback success criterion (was just restored.size === keys.length).
    const success = keys.length > 0 && restored.size === keys.length && missing.length === 0 && failedArr.length === 0;
    if (!success) console.error(`[R2-HANDOFF] INCOMPLETE: restored ${restored.size}/expected ${keys.length}, missing ${missing.length}`);
    return R(success, { manifestFound: false, source: 'list-fallback', expected: keys.length, restored: restored.size, missing, failed: failedArr });
}

/** Walk a directory recursively, return relative file paths. */
async function walkDir(dir, extensions = null) {
    const results = [];
    async function walk(current, prefix) {
        for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
            const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) await walk(path.join(current, entry.name), relPath);
            else if (!extensions || extensions.some((ext) => entry.name.endsWith(ext))) results.push(relPath);
        }
    }
    await walk(dir, '');
    return results;
}
