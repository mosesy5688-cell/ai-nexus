/**
 * R5 STAGING SUBSTRATE (Phase 2) — content-addressed blob + cycle-manifest write.
 *
 * PRODUCTION EXECUTION FENCE (Founder D-2026-0718-352): STAGE_MODE is a HARDCODED
 * module constant — NOT an env var, NOT a workflow input, NOT a repository/
 * environment variable, NOT any ungoverned toggle. In 'stage_disabled' (the ONLY
 * production value, for BOTH auto cron AND manual dispatch) every entrypoint here
 * is a no-op: ZERO PUT under data/blobs/**, data/cycles/**, data/quarantine/**,
 * ZERO GET-and-rehash, and NEVER data/current.json (Phase 3). The staged path is
 * reachable ONLY by injecting an explicit mode + deps (test dependency injection);
 * no production caller enables it. Activating staging is a FUTURE separate Founder
 * ruling that must wire real deps — this module supplies none.
 */
import crypto from 'crypto';
import { pathToFileURL } from 'url';

// HARDCODED fence constant. Do NOT source this from env/input/repo-var (see header).
export const STAGE_MODE = 'stage_disabled';
export function stagingEnabled(mode = STAGE_MODE) { return mode === 'stage_enabled'; }

// The legacy fixed-key uploader MUST NEVER enqueue a path under these prefixes.
// This is the writer-side fence: even if a local file lands under output/data/
// cycles|blobs|quarantine, the legacy PUT path skips it (new-prefix PUT count 0).
export const R5_STAGING_PREFIXES = Object.freeze(['data/blobs/', 'data/cycles/', 'data/quarantine/']);
export function isR5StagingPath(remotePath) {
    return typeof remotePath === 'string' && R5_STAGING_PREFIXES.some((p) => remotePath.startsWith(p));
}

// Single-part conditional PUT ceiling (matches r2-helpers MULTIPART_THRESHOLD).
export const BLOB_MULTIPART_THRESHOLD = 8 * 1024 * 1024;

export class R5StagingError extends Error {
    constructor(code, msg) { super(msg || code); this.name = 'R5StagingError'; this.code = code; }
}

export function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

/**
 * Create-only blob PUT with MULTIPART FAIL-CLOSED. Single-part conditional
 * (If-None-Match:*) create is proven: the whole-object sha256 IS the key, so a
 * torn/duplicate write cannot be mistaken for content. Multipart COMPLETE has NO
 * proven conditional-create semantics on this stack, so a body over the threshold
 * FAILS CLOSED — we NEVER downgrade a write-once content-address key to a
 * non-conditional multipart that could silently overwrite or tear it. putConditional
 * is injected (production = putObjectConditionalFFI with ifNoneMatch:'*'; tests = spy).
 */
export async function putBlobConditional(putConditional, sha, bytes, opts = {}) {
    const threshold = opts.multipartThreshold ?? BLOB_MULTIPART_THRESHOLD;
    if (bytes.length > threshold) {
        throw new R5StagingError('R5_MULTIPART_CONDITIONAL_UNPROVEN',
            `blob ${sha} is ${bytes.length}B > ${threshold}B single-part limit; multipart conditional-create is unproven -> fail closed (no non-conditional multipart of a write-once key)`);
    }
    return putConditional(`data/blobs/${sha}`, bytes, { ifNoneMatch: '*', contentType: 'application/octet-stream' });
}

/**
 * STAGE a finalized cycle: create-only content-addressed blob PUTs (cross-cycle
 * dedup — a pre-existing key returns precondition-failed and is SKIPPED) followed
 * by ONE create-only cycle-manifest PUT. FENCED: a no-op unless an explicit
 * mode:'stage_enabled' is injected. resolveBytes(logical) -> local artifact Buffer;
 * putConditional(key, body, {ifNoneMatch}) -> the injected conditional writer.
 * Fail-closed guards: a blob whose local bytes do NOT hash to its manifest key
 * (producer key==content invariant), a PUT that is neither ok nor precondition_failed,
 * and any oversized (multipart) blob. Only ok / deduped blobs are counted "synced";
 * a throw aborts the whole stage. NEVER writes data/current.json.
 */
export async function stageCycle({ mode = STAGE_MODE, cycleManifest, resolveBytes, putConditional, multipartThreshold, log = () => {} }) {
    if (!stagingEnabled(mode)) {
        log('[R5-STAGE] stage_disabled — fenced no-op (0 objects under data/blobs|cycles|quarantine, no GET-and-rehash)');
        return { staged: false, fenced: true, blobsPut: 0, blobsDeduped: 0, synced: [] };
    }
    if (!cycleManifest || !cycleManifest.blobs || typeof cycleManifest.blobs !== 'object') {
        throw new R5StagingError('R5_STAGE_NO_MANIFEST', 'stageCycle requires a cycle manifest with a blobs map');
    }
    const buildId = cycleManifest.build_id;
    if (!buildId) throw new R5StagingError('R5_STAGE_NO_BUILD_ID', 'cycle manifest missing build_id');
    if (typeof resolveBytes !== 'function' || typeof putConditional !== 'function') {
        throw new R5StagingError('R5_STAGE_NO_DEPS', 'stageCycle requires injected resolveBytes + putConditional');
    }
    let blobsPut = 0, blobsDeduped = 0; const synced = [];
    for (const [logical, sha] of Object.entries(cycleManifest.blobs)) {
        const bytes = await resolveBytes(logical);
        if (!bytes) throw new R5StagingError('R5_STAGE_ARTIFACT_MISSING', `local artifact bytes missing for ${logical}`);
        const actual = sha256(bytes);
        if (actual !== sha) throw new R5StagingError('R5_STAGE_KEY_CONTENT_MISMATCH', `${logical}: local sha ${actual} != manifest key ${sha}`);
        const res = await putBlobConditional(putConditional, sha, bytes, { multipartThreshold });
        if (res && res.ok) { blobsPut += 1; synced.push(logical); }
        else if (res && res.precondition_failed) { blobsDeduped += 1; synced.push(logical); }
        else throw new R5StagingError('R5_STAGE_BLOB_PUT_FAILED', `blob PUT for ${logical} (${sha}) neither ok nor precondition_failed`);
    }
    // Cycle manifest LAST (create-only). Explicitly NOT data/current.json (Phase 3).
    const manifestKey = `data/cycles/${buildId}/manifest.json`;
    const mres = await putConditional(manifestKey, Buffer.from(JSON.stringify(cycleManifest)), { ifNoneMatch: '*', contentType: 'application/json' });
    if (!(mres && (mres.ok || mres.precondition_failed))) {
        throw new R5StagingError('R5_STAGE_MANIFEST_PUT_FAILED', `cycle-manifest PUT failed for ${manifestKey}`);
    }
    log(`[R5-STAGE] staged build ${buildId}: ${blobsPut} blobs PUT, ${blobsDeduped} deduped, manifest ${mres.ok ? 'PUT' : 'exists'}`);
    return { staged: true, fenced: false, blobsPut, blobsDeduped, synced, manifestKey };
}

// Fenced workflow STAGE entrypoint — a no-op in production (stage_disabled). Opens
// no R2 client and PUTs nothing. There is NO production wiring that enables staging;
// activation is a future separate Founder ruling.
export async function main() {
    if (!stagingEnabled()) {
        console.log('[R5-STAGE] stage_disabled — fenced no-op. 0 objects under data/blobs|cycles|quarantine, no GET-and-rehash, no data/current.json. (Activation = a future separate Founder ruling.)');
        return;
    }
    throw new Error('[R5-STAGE] staging enabled but no production activation wiring exists (fenced by design).');
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) main().catch((err) => { console.error('[R5-STAGE] fatal:', err); process.exit(1); });
