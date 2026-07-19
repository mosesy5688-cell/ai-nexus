// V25.8.3 R2 Handoff — Reusable backup/restore for inter-workflow data.
import fs from 'fs/promises';
import path from 'path';
import { createR2Client, fetchR2Etags } from './r2-helpers.js';
import { isUploadEligible } from './upload-eligibility.js';
import { PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

const BUCKET = process.env.R2_BUCKET || 'ai-nexus-assets';

/**
 * Backup a single local file to R2.
 * @param {string} localPath - Local file path
 * @param {string} r2Key - R2 object key
 * @param {object} opts - { fatal: false, minSize?, requiredJson? (class-scoped required-JSON) }
 * @returns {{ success: boolean, size?: number }}
 */
export async function backupFileToR2(localPath, r2Key, opts = {}) {
    const s3 = createR2Client();
    if (!s3) {
        console.warn('[R2-HANDOFF] No R2 credentials. Skipping backup.');
        return { success: false };
    }
    try {
        const data = await fs.readFile(localPath);
        // V27.63 guard extracted VERBATIM into the shared PURE isUploadEligible (D-262 A3): the
        // manifest builder enumerates ONLY members this guard accepts. minSize maps to minBytes.
        const { eligible, reason } = isUploadEligible(localPath, data, { minBytes: opts.minSize, requiredJson: opts.requiredJson });
        if (!eligible) {
            console.error(`[R2-HANDOFF] BLOCKED: ${localPath} ${reason}. Refusing upload to prevent state wipe.`);
            return { success: false, reason: 'integrity_check_failed' };
        }
        const ext = path.extname(r2Key).toLowerCase();
        const contentType = {
            '.json': 'application/json', '.zst': 'application/zstd',
            '.gz': 'application/gzip', '.db': 'application/x-sqlite3',
            '.bin': 'application/octet-stream', '.ndjson': 'application/x-ndjson',
            '.tar': 'application/x-tar',
        }[ext] || 'application/octet-stream';

        await s3.send(new PutObjectCommand({
            Bucket: BUCKET, Key: r2Key, Body: data, ContentType: contentType
        }));
        return { success: true, size: data.length };
    } catch (e) {
        console.error(`[R2-HANDOFF] Backup failed: ${e.message}`);
        if (opts.fatal) throw e;
        return { success: false };
    }
}

/**
 * Restore a single file from R2 to local path.
 * @param {string} r2Key - R2 object key
 * @param {string} localPath - Local file path
 * @param {object} opts - { fatal: false }
 * @returns {{ success: boolean, size?: number }}
 */
export async function restoreFileFromR2(r2Key, localPath, opts = {}) {
    const s3 = createR2Client();
    if (!s3) {
        console.warn('[R2-HANDOFF] No R2 credentials. Skipping restore.');
        return { success: false };
    }
    try {
        await fs.mkdir(path.dirname(localPath), { recursive: true });
        const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: r2Key }));
        const chunks = []; for await (const c of resp.Body) chunks.push(c);
        const data = Buffer.concat(chunks);
        if (resp.ContentLength && data.length < resp.ContentLength * 0.9) { console.error(`[R2-HANDOFF] Truncated: ${r2Key} (${data.length}/${resp.ContentLength}B)`); return { success: false }; }
        await fs.writeFile(localPath, data);
        return { success: true, size: data.length };
    } catch (e) {
        console.error(`[R2-HANDOFF] Restore failed for ${r2Key}: ${e.message}`);
        if (opts.fatal) throw e;
        return { success: false };
    }
}

/**
 * Backup a local directory to R2. ATOMIC (D-356) + three-state (D-359): _manifest.json COMMIT RECORD
 * is PUT LAST, built ONLY from ELIGIBLE verified members; a POLICY_EXCLUDED file (a NON-.zst member the
 * min-size guard refuses) is NEITHER failure NOR verified and is omitted -- a corrupt .zst still fails LOUD. Partial/empty/all-excluded/manifest-fail => NO manifest.
 * @param opts {concurrency,extensions,requiredJson} @returns {{ success, count, totalSize, verified, expected, eligibleExpected, failed, skipped, policyExcluded, committed }}
 */
export async function backupDirectoryToR2(localDir, r2Prefix, opts = {}) {
    const s3 = createR2Client();
    if (!s3) { console.warn('[R2-HANDOFF] No R2 credentials. Skipping directory backup.'); return { success: false, count: 0, totalSize: 0, verified: 0, expected: 0, eligibleExpected: 0, failed: 0, skipped: 0, policyExcluded: 0, committed: false, reason: 'no_credentials' }; }
    const { concurrency = 5, extensions = null, requiredJson = false } = opts;
    const files = await walkDir(localDir, extensions);
    const expected = files.length;
    // Fail-closed default (D-356 #7): empty input is NOT a silent no-op. Best-effort call-sites opt out via shell `|| true`.
    if (expected === 0) { console.warn(`[R2-HANDOFF] No files in ${localDir} (fail-closed empty)`); return { success: false, count: 0, totalSize: 0, verified: 0, expected: 0, eligibleExpected: 0, failed: 0, skipped: 0, policyExcluded: 0, committed: false, empty: true, reason: 'empty_input' }; }
    const crypto = await import('crypto');
    const r2Etags = await fetchR2Etags(s3, BUCKET, r2Prefix).catch(() => new Map());
    console.log(`[R2-HANDOFF] Incremental backup: ${expected} local, ${r2Etags.size} on R2`);
    let uploaded = 0, skipped = 0, failed = 0, policyExcluded = 0, totalSize = 0;
    // ATOMIC (D-356 #1/#2): ONLY confirmed relPaths enter verifiedRel; the _manifest.json commit record is PUT strictly LAST.
    const verifiedRel = [];
    for (let i = 0; i < files.length; i += concurrency) {
        const batch = files.slice(i, i + concurrency);
        const results = await Promise.allSettled(batch.map(async (relPath) => {
            const rel = relPath.replace(/\\/g, '/'), localPath = path.join(localDir, relPath), r2Key = r2Prefix + rel;
            const data = await fs.readFile(localPath);
            // D-359: independent up-front eligibility; verified-skip (etag==md5, D-356 #3) is ONLY for an eligible member.
            const elig = isUploadEligible(localPath, data, { requiredJson });
            if (elig.eligible && r2Etags.get(r2Key) === crypto.createHash('md5').update(data).digest('hex')) return { rel, skipped: true };
            const result = await backupFileToR2(localPath, r2Key, { requiredJson });
            if (result.success) return { rel, size: result.size || 0 };
            // POLICY_EXCLUDED iff a NON-.zst member the uploader KNOWN-integrity-blocks AND the predicate agrees ineligible (the hard-checked sub-256B state-JSON family). A below-16B/magic-missing .zst is CORRUPTION => falls to throw = failed (loud, D-356), never a silent exclusion. eligible-but-blocked / unknown reason / rejection => failed.
            if (result.reason === 'integrity_check_failed' && !elig.eligible && !rel.endsWith('.zst')) return { rel, policyExcluded: true };
            throw new Error(`upload unconfirmed: ${rel} (reason=${result.reason || 'none'}, eligible=${elig.eligible})`);
        }));
        for (const r of results) {
            if (r.status !== 'fulfilled') { failed++; continue; }
            if (r.value.policyExcluded) { policyExcluded++; continue; }
            verifiedRel.push(r.value.rel);
            r.value.skipped ? skipped++ : (uploaded++, totalSize += r.value.size);
        }
    }
    const verified = verifiedRel.length;
    // COMMIT GATE (D-356 + D-359): enumerated = eligibleExpected + policyExcluded; verified = uploaded + identity-skip. All-excluded => eligibleExpected 0 => fail-closed. Partial => NO manifest.
    const eligibleExpected = expected - policyExcluded;
    if (eligibleExpected === 0 || verified !== eligibleExpected || failed > 0) { console.error(`[R2-HANDOFF] INCOMPLETE: ${verified}/${eligibleExpected} eligible verified, ${failed} failed, ${policyExcluded} policy-excluded -- manifest NOT written (fail-closed).`); return { success: false, count: uploaded, totalSize, verified, expected, eligibleExpected, failed, skipped, policyExcluded, committed: false, reason: eligibleExpected === 0 ? 'no_eligible_files' : 'partial_upload' }; }
    const manifestBody = JSON.stringify({ files: verifiedRel, timestamp: new Date().toISOString(), count: verifiedRel.length });
    let committed = false;
    for (let i = 0; i < 3 && !committed; i++) {
        try { const fc = createR2Client(); await fc.send(new PutObjectCommand({ Bucket: BUCKET, Key: r2Prefix + '_manifest.json', Body: manifestBody, ContentType: 'application/json' })); committed = true; }
        catch (e) { console.error(`[R2-HANDOFF] Manifest attempt ${i+1}/3: ${e.message || e.Code || JSON.stringify(e.$metadata || {})}`); if (i < 2) await new Promise(r => setTimeout(r, 2000*(i+1))); }
    }
    // Manifest PUT failure (D-356 #4) fails the whole op -> CLI non-zero.
    if (!committed) { console.error(`[R2-HANDOFF] MANIFEST WRITE FAILED (${verifiedRel.length} entries) -- backup NOT committed.`); return { success: false, count: uploaded, totalSize, verified, expected, eligibleExpected, failed, skipped, policyExcluded, committed: false, reason: 'manifest_write_failed' }; }
    console.log(`[R2-HANDOFF] Directory backup COMMITTED: ${uploaded} new + ${skipped} unchanged / ${eligibleExpected} eligible (${policyExcluded} policy-excluded) (${(totalSize/1024/1024).toFixed(1)}MB uploaded)`);
    return { success: true, count: uploaded, totalSize, verified, expected, eligibleExpected, failed, skipped, policyExcluded, committed: true };
}

/**
 * Restore a directory from R2 using manifest (fast) or prefix listing (fallback).
 * @param {string} r2Prefix - R2 key prefix
 * @param {string} localDir - Local directory to restore to
 * @param {object} opts - { concurrency: 5, fatal: false }
 * @returns {{ success: boolean, count: number }}
 */
export async function restoreDirectoryFromR2(r2Prefix, localDir, opts = {}) {
    const s3 = createR2Client();
    if (!s3) {
        console.warn('[R2-HANDOFF] No R2 credentials. Skipping directory restore.');
        return { success: false, count: 0 };
    }
    const { concurrency = 5 } = opts;

    // Try manifest-based restore first (faster, no listing needed)
    let fileKeys = [];
    try {
        const { Body } = await s3.send(new GetObjectCommand({
            Bucket: BUCKET, Key: r2Prefix + '_manifest.json'
        }));
        const chunks = [];
        for await (const c of Body) chunks.push(c);
        const manifest = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        fileKeys = (manifest.files || []).map(f => ({ key: r2Prefix + f, rel: f }));
        console.log(`[R2-HANDOFF] Manifest found: ${fileKeys.length} files`);
    } catch (e) {
        console.log(`[R2-HANDOFF] No manifest for ${r2Prefix} (${e.name || 'error'}). Listing...`);
        let token;
        do {
            const resp = await s3.send(new ListObjectsV2Command({
                Bucket: BUCKET, Prefix: r2Prefix, MaxKeys: 1000, ContinuationToken: token
            }));
            for (const obj of resp.Contents || []) {
                if (obj.Key.endsWith('_manifest.json')) continue;
                const rel = obj.Key.slice(r2Prefix.length);
                fileKeys.push({ key: obj.Key, rel });
            }
            token = resp.NextContinuationToken;
        } while (token);
    }

    if (fileKeys.length === 0) {
        console.warn(`[R2-HANDOFF] No files found under ${r2Prefix}`);
        return { success: false, count: 0 };
    }

    console.log(`[R2-HANDOFF] Restoring ${fileKeys.length} files to ${localDir}...`);
    let restored = 0;
    const restoredPaths = new Set();
    for (let i = 0; i < fileKeys.length; i += concurrency) {
        const batch = fileKeys.slice(i, i + concurrency);
        const results = await Promise.allSettled(batch.map(async ({ key, rel }) => {
            const r = await restoreFileFromR2(key, path.join(localDir, rel));
            if (r.success) restoredPaths.add(rel);
            return r;
        }));
        restored += results.filter(r => r.status === 'fulfilled' && r.value.success).length;
    }
    const failed = fileKeys.length - restored;
    if (failed > 0) {
        console.warn(`[R2-HANDOFF] ${failed} files missed from manifest. Supplementing via ListObjects...`);
        let token;
        do {
            const resp = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: r2Prefix, MaxKeys: 1000, ContinuationToken: token }));
            for (const obj of resp.Contents || []) {
                if (obj.Key.endsWith('_manifest.json')) continue;
                const rel = obj.Key.slice(r2Prefix.length);
                if (restoredPaths.has(rel)) continue;
                for (let retry = 0; retry < 2; retry++) {
                    const r = await restoreFileFromR2(obj.Key, path.join(localDir, rel)).catch(() => ({ success: false }));
                    if (r.success) { restored++; restoredPaths.add(rel); break; }
                    if (retry === 0) await new Promise(r => setTimeout(r, 1000));
                }
            }
            token = resp.NextContinuationToken;
        } while (token);
        console.log(`[R2-HANDOFF] After ListObjects: ${restored} files total`);
    }
    console.log(`[R2-HANDOFF] Directory restore: ${restored} files`);
    return { success: restored > 0, count: restored };
}

/**
 * Walk a directory recursively, return relative file paths.
 */
async function walkDir(dir, extensions = null) {
    const results = [];
    async function walk(current, prefix) {
        const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                await walk(path.join(current, entry.name), relPath);
            } else if (!extensions || extensions.some(ext => entry.name.endsWith(ext))) {
                results.push(relPath);
            }
        }
    }
    await walk(dir, '');
    return results;
}

// CLI entry point
if (process.argv[1]?.endsWith('r2-handoff.js')) {
    const [action, src, dest] = process.argv.slice(2);
    if (action === 'backup-dir') {
        backupDirectoryToR2(src, dest).then(r => console.log(JSON.stringify(r)));
    } else if (action === 'restore-dir') {
        restoreDirectoryFromR2(src, dest).then(r => console.log(JSON.stringify(r)));
    } else {
        console.log('Usage: r2-handoff.js <backup-dir|restore-dir> <src> <dest>');
    }
}
