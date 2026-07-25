/**
 * Rankings DB Verifier - the COMPLETE-SET verification of record for the EXACT
 * `rankings-<group>.db` publication set (Founder rankings-authority repair, D7/D9).
 *
 * There is NO count-only / any-one-file shortcut here: a caller either gets a
 * fully verified EXACT set or a machine-coded failure. Checks run cheap -> expensive:
 *   (1) presence + non-zero size (+ size/sha256 vs the handoff manifest when supplied)
 *   (2) SQLite magic: the first 16 bytes are exactly "SQLite format 3\0"
 *   (3) PRAGMA quick_check (NOT integrity_check: the O(n) index cross-check adds
 *       no marginal signal for a freshly written, VACUUMed single-writer DB)
 *   (4) schema assertion DERIVED from rankings-db-exporter.RANKINGS_SCHEMA (tables
 *       superset, `entities` column-name SET EQUALITY, every declared index) so the
 *       producer schema and the verifier can never drift apart
 *   (5) provenance: required site_metadata keys, entity_count numeric > 0,
 *       rankings_group == filename group, run/attempt/head IDENTICAL across all
 *       members (+ optional equality against a caller-supplied cycle identity)
 *   (6) EXACT set equality against RANKINGS_DB_NAMES - a missing member fails, an
 *       EXTRA `rankings-*.db` fails.
 *
 * `entity_count` semantics/type are UNCHANGED (TEXT, live-read by
 * src/utils/catalog-fetcher.js for pagination); this module only reads it.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { RANKINGS_DB_NAMES, RANKINGS_DB_COUNT, rankingsGroupFromDbName } from '../../../src/constants/rankings-groups.js';
import { RANKINGS_SCHEMA } from './rankings-db-exporter.js';

/** The 16-byte SQLite file header (NUL-terminated), latin1. */
export const SQLITE_MAGIC = 'SQLite format 3\u0000';
/** site_metadata keys every rankings DB MUST carry (identity + provenance). */
export const REQUIRED_META_KEYS = Object.freeze([
    'rankings_group', 'entity_count', 'generated',
    'factory_run_id', 'factory_run_attempt', 'head_sha',
]);
/** The identity triple all members must agree on. */
export const IDENTITY_META_KEYS = Object.freeze(['factory_run_id', 'factory_run_attempt', 'head_sha']);
const GITSHA_RE = /^[0-9a-f]{40}$/;
const RANKINGS_DB_FILE_RE = /^rankings-.*\.db$/;

export class RankingsDbVerifyError extends Error {
    constructor(code, message) {
        super(`${code}: ${message}`);
        this.name = 'RankingsDbVerifyError';
        this.code = code;
    }
}
const fail = (code, reason) => ({ ok: false, code, reason });

// Schema expectations DERIVED from the producer's RANKINGS_SCHEMA (never hand-copied).
function deriveSchema() {
    const tables = [...RANKINGS_SCHEMA.matchAll(/CREATE TABLE\s+(\w+)/g)].map((m) => m[1]);
    const indexes = [...RANKINGS_SCHEMA.matchAll(/CREATE INDEX\s+(\w+)/g)].map((m) => m[1]);
    const body = /CREATE TABLE\s+entities\s*\(([\s\S]*?)\);/.exec(RANKINGS_SCHEMA);
    const columns = String(body ? body[1] : '').split(',')
        .map((s) => s.trim().split(/\s+/)[0]).filter(Boolean);
    return Object.freeze({ tables: Object.freeze(tables), indexes: Object.freeze(indexes), columns: Object.freeze(columns) });
}
const SCHEMA = deriveSchema();
export function expectedTables() { return SCHEMA.tables; }
export function expectedIndexes() { return SCHEMA.indexes; }
export function expectedEntityColumns() { return SCHEMA.columns; }

function sameSet(a, b) {
    const A = new Set(a); const B = new Set(b);
    if (A.size !== B.size) return false;
    for (const v of A) if (!B.has(v)) return false;
    return true;
}

function readMagic(absPath) {
    const fd = fs.openSync(absPath, 'r');
    try {
        const buf = Buffer.alloc(16);
        return fs.readSync(fd, buf, 0, 16, 0) === 16 ? buf.toString('latin1') : '';
    } finally { fs.closeSync(fd); }
}

/**
 * Index the rankings-DB members of a handoff manifest by BASENAME.
 * @returns {Map<string,object>|null} null when no manifest was supplied.
 */
export function manifestRankingsIndex(manifest, memberPrefix = '') {
    if (!manifest || !Array.isArray(manifest.files)) return null;
    const out = new Map();
    for (const f of manifest.files) {
        const rel = String(f && f.relative_path || '');
        if (memberPrefix && !rel.startsWith(memberPrefix)) continue;
        const base = rel.slice(memberPrefix.length);
        if (base.includes('/') || !RANKINGS_DB_FILE_RE.test(base)) continue;
        out.set(base, f);
    }
    return out;
}

/**
 * Verify ONE rankings DB (checks 1-5). Pure result object; never throws for a
 * verification failure (only a programming error would throw).
 */
export function verifyRankingsDbFile(absPath, group, manifestEntry = null) {
    let st;
    try { st = fs.statSync(absPath); } catch { return fail('DB_MISSING', `absent: ${absPath}`); }
    if (!st.isFile() || st.size === 0) return fail('DB_EMPTY', `zero-byte/non-file: ${absPath}`);
    if (manifestEntry) {
        if (Number(manifestEntry.size_bytes) !== st.size) {
            return fail('SIZE_MISMATCH', `${group}: disk ${st.size} != manifest ${manifestEntry.size_bytes}`);
        }
        const sha = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
        if (sha !== String(manifestEntry.sha256)) return fail('HASH_MISMATCH', `${group}: sha256 != manifest`);
    }
    if (readMagic(absPath) !== SQLITE_MAGIC) return fail('SQLITE_MAGIC_INVALID', `${group}: not a SQLite 3 file`);
    let db = null;
    try { db = new Database(absPath, { readonly: true, fileMustExist: true }); }
    catch (e) { return fail('SQLITE_OPEN_FAILED', `${group}: ${e.message}`); }
    try {
        const qc = db.pragma('quick_check');
        const verdict = String((qc && qc[0] && (qc[0].quick_check ?? Object.values(qc[0])[0])) ?? '').toLowerCase();
        if (verdict !== 'ok') return fail('SQLITE_QUICK_CHECK_FAILED', `${group}: quick_check=${verdict || '(empty)'}`);
        const objs = db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table','index')").all();
        const tables = new Set(objs.filter((o) => o.type === 'table').map((o) => o.name));
        for (const t of expectedTables()) if (!tables.has(t)) return fail('SCHEMA_TABLE_MISSING', `${group}: table ${t}`);
        const idx = new Set(objs.filter((o) => o.type === 'index').map((o) => o.name));
        for (const i of expectedIndexes()) if (!idx.has(i)) return fail('SCHEMA_INDEX_MISSING', `${group}: index ${i}`);
        const cols = db.pragma('table_info(entities)').map((r) => r.name);
        if (!sameSet(cols, expectedEntityColumns())) {
            return fail('SCHEMA_COLUMN_MISMATCH', `${group}: entities has ${cols.length} cols, expected ${expectedEntityColumns().length} (set equality)`);
        }
        const meta = new Map(db.prepare('SELECT key, value FROM site_metadata').all().map((r) => [r.key, r.value]));
        for (const k of REQUIRED_META_KEYS) {
            if (!meta.has(k) || String(meta.get(k) ?? '') === '') return fail('META_KEY_MISSING', `${group}: site_metadata.${k}`);
        }
        const entityCount = Number(meta.get('entity_count'));
        if (!Number.isFinite(entityCount) || entityCount <= 0) {
            return fail('ENTITY_COUNT_INVALID', `${group}: entity_count=${meta.get('entity_count')}`);
        }
        if (String(meta.get('rankings_group')) !== group) {
            return fail('GROUP_METADATA_MISMATCH', `${group}: site_metadata.rankings_group=${meta.get('rankings_group')}`);
        }
        const attempt = Number(meta.get('factory_run_attempt'));
        if (!Number.isInteger(attempt) || attempt < 1) {
            return fail('IDENTITY_ATTEMPT_INVALID', `${group}: factory_run_attempt=${meta.get('factory_run_attempt')}`);
        }
        const headSha = String(meta.get('head_sha'));
        if (!GITSHA_RE.test(headSha)) return fail('IDENTITY_HEAD_INVALID', `${group}: head_sha=${headSha}`);
        return {
            ok: true, code: 'OK', reason: 'db-verified', group, entityCount,
            identity: { runId: String(meta.get('factory_run_id')), attempt, headSha },
        };
    } catch (e) {
        return fail('SQLITE_READ_FAILED', `${group}: ${e.message}`);
    } finally {
        try { db.close(); } catch { /* already closed */ }
    }
}

/**
 * Verify the COMPLETE rankings DB set in `dir` (checks 1-6 + cross-member identity).
 * @param {string} dir directory holding `rankings-<group>.db`
 * @param {{manifest?:object, memberPrefix?:string, expectRunId?:string,
 *          expectHeadSha?:string, maxAttempt?:(number|string)}} [opts]
 */
export function verifyRankingsDbSet(dir, opts = {}) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch (e) { return fail('DB_DIR_UNREADABLE', `${dir}: ${e.message}`); }
    const present = entries.filter((f) => RANKINGS_DB_FILE_RE.test(f)).sort();
    const expect = [...RANKINGS_DB_NAMES].sort();
    const missing = expect.filter((n) => !present.includes(n));
    if (missing.length) return fail('RANKINGS_DB_SET_MISSING', `${present.length}/${RANKINGS_DB_COUNT} present; missing: ${missing.join(',')}`);
    const extra = present.filter((n) => !expect.includes(n));
    if (extra.length) return fail('RANKINGS_DB_SET_EXTRA', `unexpected rankings DB(s): ${extra.join(',')}`);
    const byName = manifestRankingsIndex(opts.manifest, opts.memberPrefix || '');
    if (byName && byName.size !== RANKINGS_DB_COUNT) {
        return fail('MANIFEST_MEMBER_COUNT_MISMATCH', `manifest declares ${byName.size} rankings members != ${RANKINGS_DB_COUNT}`);
    }
    let identity = null;
    const members = [];
    for (const name of expect) {
        const group = rankingsGroupFromDbName(name);
        if (!group) return fail('RANKINGS_DB_NAME_UNKNOWN', name);
        if (byName && !byName.has(name)) return fail('MANIFEST_MEMBER_MISSING', `${name} absent from the handoff manifest`);
        const r = verifyRankingsDbFile(path.join(dir, name), group, byName ? byName.get(name) : null);
        if (!r.ok) return r;
        if (!identity) identity = r.identity;
        else if (identity.runId !== r.identity.runId || identity.attempt !== r.identity.attempt || identity.headSha !== r.identity.headSha) {
            return fail('IDENTITY_INCONSISTENT', `${name} identity ${r.identity.runId}/${r.identity.attempt}/${r.identity.headSha} != ${identity.runId}/${identity.attempt}/${identity.headSha}`);
        }
        members.push({ name, group, entityCount: r.entityCount });
    }
    if (opts.expectRunId && identity.runId !== String(opts.expectRunId)) {
        return fail('IDENTITY_RUN_MISMATCH', `DB factory_run_id ${identity.runId} != expected ${opts.expectRunId}`);
    }
    if (opts.expectHeadSha && identity.headSha !== String(opts.expectHeadSha).toLowerCase()) {
        return fail('IDENTITY_HEAD_MISMATCH', `DB head_sha ${identity.headSha} != expected ${opts.expectHeadSha}`);
    }
    if (opts.maxAttempt !== undefined && opts.maxAttempt !== null && opts.maxAttempt !== '') {
        const cap = Number(opts.maxAttempt);
        if (!Number.isInteger(cap) || cap < 1) return fail('MAX_ATTEMPT_INVALID', `maxAttempt=${opts.maxAttempt}`);
        if (identity.attempt > cap) return fail('IDENTITY_ATTEMPT_FUTURE', `DB attempt ${identity.attempt} > current ${cap}`);
    }
    return { ok: true, code: 'OK', reason: 'set-verified', count: RANKINGS_DB_COUNT, identity, members };
}

/** THROWING wrapper (fail-closed call sites: pack-finalizer + the CLI gates). */
export function assertRankingsDbSet(dir, opts = {}) {
    const res = verifyRankingsDbSet(dir, opts);
    if (!res.ok) throw new RankingsDbVerifyError(res.code, `${res.reason} (dir=${dir})`);
    return res;
}

/**
 * Resolve verification options from env (the workflow-facing convention, mirroring
 * the HANDOFF_* env used by the handoff carriers). RANKINGS_DB_MANIFEST points at
 * a handoff manifest JSON whose members carry the authoritative size+sha256.
 *
 * NO SILENT DEGRADE: on a workflow path the caller MUST set RANKINGS_REQUIRE_IDENTITY=1.
 * An EMPTY expectation would otherwise mean "skip that check", so a failed
 * $GITHUB_OUTPUT write in the promotion step would quietly downgrade the gate from
 * identity-bound to structure-only with NO signal -- exactly the silent-optional
 * pattern this repair exists to eliminate. Under the flag, an empty IDENTITY expectation
 * => THROW. The flag deliberately covers ONLY the three identity expectations, not
 * RANKINGS_DB_MANIFEST: the producer pre-checks run BEFORE the manifest is generated, so
 * requiring it there would be a false constraint (those call sites are hash-bound later,
 * at the producer read-back).
 */
export function verifyOptsFromEnv(env = process.env) {
    const opts = {
        memberPrefix: env.RANKINGS_MEMBER_PREFIX || '',
        expectRunId: env.RANKINGS_EXPECT_RUN_ID || '',
        expectHeadSha: env.RANKINGS_EXPECT_HEAD_SHA || '',
        maxAttempt: env.RANKINGS_MAX_ATTEMPT || '',
    };
    const p = env.RANKINGS_DB_MANIFEST || '';
    if (env.RANKINGS_REQUIRE_IDENTITY === '1') {
        const missing = [
            ['RANKINGS_EXPECT_RUN_ID', opts.expectRunId],
            ['RANKINGS_EXPECT_HEAD_SHA', opts.expectHeadSha], ['RANKINGS_MAX_ATTEMPT', opts.maxAttempt],
        ].filter(([, v]) => !v).map(([k]) => k);
        if (missing.length) {
            throw new RankingsDbVerifyError('IDENTITY_BINDING_REQUIRED_BUT_EMPTY',
                `RANKINGS_REQUIRE_IDENTITY=1 but empty: ${missing.join(', ')} - refusing a structure-only verification`);
        }
    }
    if (p) opts.manifest = JSON.parse(fs.readFileSync(p, 'utf8'));
    return opts;
}
