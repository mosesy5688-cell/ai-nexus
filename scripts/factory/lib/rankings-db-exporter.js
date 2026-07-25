/**
 * Rankings DB Exporter (V3 §5.0)
 * Writes per-group rankings to standalone SQLite DBs for VFS-compliant SSR consumption.
 * Each DB is a self-contained subset of the meta-NN.db schema — 1 R2 Range Read per type.
 *
 * EXACT-SET CONTRACT (rankings-authority repair, D6/D11): the group set is the single
 * source RANKINGS_GROUPS (src/constants/rankings-groups.js) and ALL of them must be
 * non-empty — a silently-short export is the upstream half of the
 * `manifest.partitions.rankings_dbs` outage, so an empty group now fails LOUD with the
 * offending group names AND their entity counts (so an operator can tell "pipeline
 * broke" from "group legitimately empty"). Every DB also carries the cycle identity
 * (factory_run_id / factory_run_attempt / head_sha) so the downstream complete-set
 * verification can prove all 10 members came from the SAME run+attempt+code head.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { classifyLicense } from './row-builders.js';
import { RANKINGS_GROUPS, RANKINGS_DB_COUNT, rankingsDbName } from '../../../src/constants/rankings-groups.js';

/**
 * V25.11 (2026-05-03, #1925 fix): Defensive filter for the 'model' rankings DB.
 *
 * Background: Even after GitHub adapter inferType fix (removing README keyword
 * inference), historical entities from past harvests may still have type=model
 * incorrectly. This filter applies at the LAST gate (rankings DB write) to
 * ensure no GitHub repo without genuine model signals enters rankings-model.db.
 *
 * Civitai / Replicate / Kaggle / Ollama / HF entities pass through (they are
 * legitimate model sources even when individual fields like params_billions
 * are null — e.g., Civitai SD checkpoints don't use the LLM params schema).
 *
 * @param {Object} e - Entity object
 * @returns {boolean} True if entity qualifies for rankings-model.db
 */
function qualifiesForModelRanking(e) {
    const id = e.id || '';

    // HuggingFace: trust HF API classification (real models)
    if (id.startsWith('hf-model--') || id.startsWith('hf-')) return true;

    // Civitai / Replicate / Kaggle / Ollama: real model sources (image, hosted, GGUF)
    if (id.startsWith('civitai-') || id.startsWith('replicate-') ||
        id.startsWith('kaggle-') || id.startsWith('ollama-')) return true;

    // GitHub (gh-model-- or github-): require strong model signal
    if (id.startsWith('gh-') || id.startsWith('github-')) {
        return !!(
            (e.architecture && e.architecture.length > 0) ||
            (e.params_billions && Number(e.params_billions) > 0) ||
            e.has_safetensors ||
            e.has_gguf
        );
    }

    // Unknown source: pass (conservative default)
    return true;
}

export const RANKINGS_SCHEMA = `
    CREATE TABLE entities (
        id TEXT PRIMARY KEY, slug TEXT, name TEXT, type TEXT, author TEXT,
        summary TEXT, fni_score REAL, pipeline_tag TEXT, license TEXT,
        vram_estimate_gb REAL, params_billions REAL, context_length INTEGER DEFAULT 0,
        stars INTEGER DEFAULT 0, downloads INTEGER DEFAULT 0, raw_pop REAL DEFAULT 0,
        fni_s REAL DEFAULT 0, fni_a REAL DEFAULT 0, fni_p REAL DEFAULT 0,
        fni_r REAL DEFAULT 0, fni_q REAL DEFAULT 0,
        bundle_key TEXT, bundle_offset INTEGER, bundle_size INTEGER,
        last_modified TEXT, category TEXT, architecture TEXT,
        task_categories TEXT, forks INTEGER DEFAULT 0, citation_count INTEGER DEFAULT 0,
        ollama_compatible INTEGER DEFAULT 0, hosted_on TEXT DEFAULT '[]',
        license_type TEXT DEFAULT 'unknown', can_run_local INTEGER DEFAULT 0,
        hosted_on_checked_at TEXT
    );
    CREATE TABLE site_metadata (key TEXT PRIMARY KEY, value TEXT);
    CREATE INDEX idx_fni ON entities(fni_score DESC);
    CREATE INDEX idx_type ON entities(type);
    CREATE INDEX idx_pipeline ON entities(pipeline_tag);
    CREATE INDEX idx_ollama ON entities(ollama_compatible);
    CREATE INDEX idx_license_type ON entities(license_type);
`;

const INSERT_SQL = `INSERT OR IGNORE INTO entities (
    id, slug, name, type, author, summary, fni_score, pipeline_tag, license,
    vram_estimate_gb, params_billions, context_length, stars, downloads, raw_pop,
    fni_s, fni_a, fni_p, fni_r, fni_q,
    bundle_key, bundle_offset, bundle_size, last_modified, category, architecture,
    task_categories, forks, citation_count,
    ollama_compatible, hosted_on, license_type, can_run_local, hosted_on_checked_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

const GITSHA_RE = /^[0-9a-f]{40}$/;

/**
 * Resolve the cycle identity stamped into every rankings DB's site_metadata.
 *
 * EXPLICIT POLICY (D6): the three env vars are MANDATORY and a missing/malformed
 * value fails LOUD. A DB written with empty/invented identity would be REJECTED by
 * the downstream complete-set verification, so it must never be written at all —
 * "no silent failure" over local-dev convenience. The only production caller is the
 * 3/4 `aggregate-rankings` job, which supplies github.run_id / github.run_attempt /
 * github.sha (mirroring the HANDOFF_* env convention of the handoff carriers).
 *
 * @param {Object} [env]
 * @returns {{runId: string, attempt: string, headSha: string}}
 */
export function resolveRankingsIdentity(env = process.env) {
    const runId = String(env.RANKINGS_RUN_ID || '').trim();
    const attempt = String(env.RANKINGS_RUN_ATTEMPT || '').trim();
    const headSha = String(env.RANKINGS_HEAD_SHA || '').trim().toLowerCase();
    const bad = [];
    if (!/^[0-9]+$/.test(runId)) bad.push(`RANKINGS_RUN_ID="${runId}"`);
    if (!/^[0-9]+$/.test(attempt) || Number(attempt) < 1) bad.push(`RANKINGS_RUN_ATTEMPT="${attempt}"`);
    if (!GITSHA_RE.test(headSha)) bad.push(`RANKINGS_HEAD_SHA="${headSha}"`);
    if (bad.length) {
        throw new Error(`RANKINGS_IDENTITY_ENV_INVALID: missing/malformed ${bad.join(', ')} - refusing to write rankings DBs without a verifiable run/attempt/head identity`);
    }
    return { runId, attempt, headSha };
}

/**
 * Apply the per-group admission rules and return the EXACT ordered set of
 * (group -> entities) that will be written. Throws when the EXACT-10 floor is
 * violated, naming every offending group and every per-group count.
 */
export function prepareRankingsGroups(groups) {
    const unknown = Object.keys(groups || {}).filter((g) => !RANKINGS_GROUPS.includes(g));
    if (unknown.length) {
        throw new Error(`RANKINGS_GROUP_UNEXPECTED: accumulator carries non-rankings group(s) [${unknown.join(', ')}] - the rankings DB set is EXACTLY [${RANKINGS_GROUPS.join(', ')}]`);
    }
    const prepared = new Map();
    const counts = [];
    for (const groupName of RANKINGS_GROUPS) {
        const entitiesIn = Array.isArray(groups && groups[groupName]) ? groups[groupName] : [];
        let entities = entitiesIn;
        if (groupName === 'model') {
            entities = entitiesIn.filter(qualifiesForModelRanking);
            const dropped = entitiesIn.length - entities.length;
            if (dropped > 0) {
                console.log(`  [RANKINGS-DB] ${groupName}: filtered out ${dropped} non-qualified entities (#1925 GitHub repo without model signal)`);
            }
        }
        prepared.set(groupName, entities);
        counts.push(entities.length === entitiesIn.length ? `${groupName}=${entities.length}` : `${groupName}=${entities.length}(of ${entitiesIn.length})`);
    }
    const empty = RANKINGS_GROUPS.filter((g) => prepared.get(g).length === 0);
    if (empty.length) {
        throw new Error(`RANKINGS_GROUP_EMPTY: ${empty.length}/${RANKINGS_DB_COUNT} rankings group(s) have ZERO entities [${empty.join(', ')}]; per-group counts: ${counts.join(' ')}. The EXACT-${RANKINGS_DB_COUNT} rankings DB set is a HARD floor - refusing to emit a partial set.`);
    }
    console.log(`[RANKINGS-DB] group counts: ${counts.join(' ')}`);
    return prepared;
}

export async function exportRankingsDbs(groups, outputDir) {
    const identity = resolveRankingsIdentity();
    const prepared = prepareRankingsGroups(groups);
    const dataDir = path.join(outputDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    let totalDbs = 0;

    for (const groupName of RANKINGS_GROUPS) {
        const entities = prepared.get(groupName);
        const dbPath = path.join(dataDir, rankingsDbName(groupName));
        fs.rmSync(dbPath, { force: true }); // never append onto a stale/foreign DB
        const db = new Database(dbPath);
        db.pragma('journal_mode = OFF');
        db.pragma('synchronous = OFF');
        db.exec(RANKINGS_SCHEMA);
        const insert = db.prepare(INSERT_SQL);
        db.exec('BEGIN');
        const str = v => typeof v === 'string' ? v : (Array.isArray(v) || typeof v === 'object') ? JSON.stringify(v) : String(v || '');
        for (const e of entities) {
            insert.run(
                e.id, e.slug || '', e.name || e.slug || '', e.type || 'model',
                str(e.author), (str(e.description || e.summary)).substring(0, 500),
                e.fni_score || e.fni || 0, e.pipeline_tag || '', e.license || '',
                e.vram_estimate_gb || 0, e.params_billions ?? 0, e.context_length ?? 0,
                e.stars || 0, e.downloads || 0, e.raw_pop || 0,
                e.fni_s ?? 50.0, e.fni_a ?? 0, e.fni_p ?? 0, e.fni_r ?? 0, e.fni_q ?? 0,
                e.bundle_key || '', e.bundle_offset ?? 0, e.bundle_size ?? 0,
                e.last_modified || '', e.category || '', str(e.architecture),
                str(e.task_categories), e.forks || 0, e.citation_count || 0,
                e.ollama_compatible ?? (e.has_ollama || e.has_gguf ? 1 : 0),
                str(e.hosted_on) || '[]',
                e.license_type || classifyLicense(e.license),
                e.can_run_local ?? (((e.has_ollama || e.has_gguf) && ((e.params_billions ?? 0) <= 13 || !e.params_billions)) ? 1 : 0),
                e.hosted_on_checked_at || null
            );
        }
        db.exec('COMMIT');
        const metaInsert = db.prepare('INSERT INTO site_metadata (key, value) VALUES (?, ?)');
        metaInsert.run('rankings_group', groupName);
        // entity_count meaning + TEXT type UNCHANGED (live-read by catalog-fetcher pagination).
        metaInsert.run('entity_count', String(entities.length));
        metaInsert.run('generated', new Date().toISOString());
        // D6 per-DB cycle identity: all 10 members must agree, and must match the
        // producing run/attempt/code head the handoff descriptor binds.
        metaInsert.run('factory_run_id', identity.runId);
        metaInsert.run('factory_run_attempt', identity.attempt);
        metaInsert.run('head_sha', identity.headSha);
        db.exec('VACUUM');
        db.close();
        const sizeMb = (fs.statSync(dbPath).size / 1048576).toFixed(2);
        console.log(`  [RANKINGS-DB] ${groupName}: ${entities.length} entities → ${sizeMb}MB`);
        totalDbs++;
    }
    if (totalDbs !== RANKINGS_DB_COUNT) {
        throw new Error(`RANKINGS_DB_COUNT_MISMATCH: wrote ${totalDbs} databases, expected EXACTLY ${RANKINGS_DB_COUNT}`);
    }
    console.log(`[RANKINGS-DB] Exported ${totalDbs} ranking databases to ${dataDir} (run=${identity.runId} attempt=${identity.attempt} head=${identity.headSha})`);
}
