/**
 * Rankings Group Constants - Single Source of Truth
 *
 * The EXACT set of per-group rankings databases published as
 * `output/data/rankings-<group>.db` and read by:
 *   - src/pages/api/v1/select.ts        (rankings-model.db, gated on
 *                                        manifest.partitions.rankings_dbs)
 *   - src/utils/catalog-fetcher.js      (rankings-<type>.db list fast path)
 * and produced by scripts/factory/lib/rankings-db-exporter.js.
 *
 * Why this lives in src/constants/ as plain .js (same rationale as
 * src/constants/shard-constants.js):
 *   - Node factory scripts (scripts/factory/**) import it at build time -> plain ESM
 *   - Astro SSR / TS imports it type-compatibly
 *   A .ts file would block the Node packer (no native TS execution).
 *
 * ORDER IS PART OF THE CONTRACT: [all] + the 5 V6 category slugs + the 4 served
 * entity types. Any change here changes the EXACT-set floor enforced end-to-end
 * (exporter -> rankings-satellite carrier -> rankings-db carrier -> pack-finalizer
 * -> the pre-publish gate), so it is a deliberate, test-locked edit.
 */

// The 5 V6 category slugs. Parity-locked against src/config/constants.ts
// CATEGORY_SLUGS by tests/srs1/rankings-db-authority-invariant.test.ts.
export const RANKINGS_CATEGORIES = Object.freeze([
    'text-generation',
    'knowledge-retrieval',
    'vision-multimedia',
    'automation-workflow',
    'infrastructure-ops',
]);

// The 4 served entity types. 'prompt' (#2141), 'space' (merged into model) and
// 'agent' (cancelled) are dropped at the pack source, so no rankings-prompt.db /
// rankings-space.db / rankings-agent.db exists. MCP servers rank as 'tool'.
export const RANKINGS_ENTITY_TYPES = Object.freeze(['model', 'paper', 'dataset', 'tool']);

// The global (cross-type) group.
export const RANKINGS_GLOBAL_GROUP = 'all';

/** The EXACT ordered rankings group set (10 members). */
export const RANKINGS_GROUPS = Object.freeze([
    RANKINGS_GLOBAL_GROUP,
    ...RANKINGS_CATEGORIES,
    ...RANKINGS_ENTITY_TYPES,
]);

/** The EXACT expected rankings DB count (10). Never a floor, never a minimum. */
export const RANKINGS_DB_COUNT = RANKINGS_GROUPS.length;

const GROUP_SET = Object.freeze(new Set(RANKINGS_GROUPS));

/** True iff `group` is one of the EXACT 10 rankings groups. */
export function isRankingsGroup(group) {
    return GROUP_SET.has(String(group));
}

/** Map a group name to its canonical DB filename. Throws on an unknown group. */
export function rankingsDbName(group) {
    if (!isRankingsGroup(group)) {
        throw new Error(`RANKINGS_GROUP_UNKNOWN: "${group}" is not one of the ${RANKINGS_DB_COUNT} rankings groups`);
    }
    return `rankings-${group}.db`;
}

/** The EXACT ordered rankings DB filename set (10 members). */
export const RANKINGS_DB_NAMES = Object.freeze(RANKINGS_GROUPS.map((g) => `rankings-${g}.db`));

const DB_NAME_RE = /^rankings-([a-z0-9-]+)\.db$/;

/**
 * Recover the group from a `rankings-<group>.db` filename, or null when the name
 * is not a KNOWN rankings DB (an unknown/extra `rankings-*.db` returns null so
 * callers can fail closed instead of inventing a group).
 */
export function rankingsGroupFromDbName(fileName) {
    const m = DB_NAME_RE.exec(String(fileName || ''));
    return m && isRankingsGroup(m[1]) ? m[1] : null;
}
