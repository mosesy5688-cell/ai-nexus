// tests/srs1/rankings-db-verifier-source-invariant.test.ts
//
// SRS-1 Tier-1 STATIC lock for the RANKINGS-DB AUTHORITY repair, part 3 of 3: the
// complete-set verifier of record + both carriers + the exporter floors are present in
// SOURCE, the node --test suite is wired into the blocking list, and the BYTE-FROZEN
// transport / sibling carriers are untouched. Parts 1-2 =
// rankings-db-authority-invariant.test.ts / rankings-db-seam-b-publication-invariant.test.ts.
import { describe, it, expect } from 'vitest';
import { CARRIER, VERIFIER, EXPORTER, SUITE, read, exists, jsCodeOf } from './rankings-db-wf-fixtures';

describe('RANKINGS-DB-SET-10 / IDENTITY — the verifier of record is complete-set, never count-only', () => {
  it('#21 the verifier implements every named check and no `.some()` / count-only shortcut', () => {
    expect(VERIFIER).toContain("export const SQLITE_MAGIC = 'SQLite format 3\\u0000';");
    expect(VERIFIER).toContain("db.pragma('quick_check')");
    // quick_check, NOT the O(n) index cross-check (the doc comment may NAME it; no CALL may exist)
    expect(VERIFIER).not.toContain("pragma('integrity_check')");
    expect(VERIFIER).toContain("db.pragma('table_info(entities)')");
    for (const code of [
      'RANKINGS_DB_SET_MISSING', 'RANKINGS_DB_SET_EXTRA', 'MANIFEST_MEMBER_COUNT_MISMATCH',
      'MANIFEST_MEMBER_MISSING', 'DB_EMPTY', 'SIZE_MISMATCH', 'HASH_MISMATCH',
      'SQLITE_MAGIC_INVALID', 'SQLITE_QUICK_CHECK_FAILED', 'SCHEMA_TABLE_MISSING',
      'SCHEMA_INDEX_MISSING', 'SCHEMA_COLUMN_MISMATCH', 'META_KEY_MISSING',
      'ENTITY_COUNT_INVALID', 'GROUP_METADATA_MISMATCH', 'IDENTITY_ATTEMPT_INVALID',
      'IDENTITY_HEAD_INVALID', 'IDENTITY_INCONSISTENT', 'IDENTITY_RUN_MISMATCH',
      'IDENTITY_HEAD_MISMATCH', 'IDENTITY_ATTEMPT_FUTURE',
    ]) {
      expect(VERIFIER, `missing machine code ${code}`).toContain(`fail('${code}'`);
    }
    expect(VERIFIER).not.toMatch(/\.some\(/);
    // the schema expectations are DERIVED from the producer schema, not hand-copied
    expect(VERIFIER).toContain("import { RANKINGS_SCHEMA } from './rankings-db-exporter.js';");
    expect(VERIFIER).toMatch(/CREATE TABLE\\s\+\(\\w\+\)/);
    expect(VERIFIER).toMatch(/CREATE INDEX\\s\+\(\\w\+\)/);
    // the required provenance key set (identity is not optional)
    for (const k of ['rankings_group', 'entity_count', 'generated', 'factory_run_id', 'factory_run_attempt', 'head_sha']) {
      expect(VERIFIER).toContain(`'${k}'`);
    }
    // a THROWING wrapper exists for the fail-closed call sites
    expect(VERIFIER).toMatch(/export function assertRankingsDbSet/);
    expect(VERIFIER).toMatch(/throw new RankingsDbVerifyError/);
    // NO SILENT DEGRADE: an EMPTY identity expectation under RANKINGS_REQUIRE_IDENTITY=1
    // throws its own code instead of quietly meaning "skip that check".
    expect(VERIFIER).toContain("env.RANKINGS_REQUIRE_IDENTITY === '1'");
    expect(VERIFIER).toContain("'IDENTITY_BINDING_REQUIRED_BUT_EMPTY'");
  });

  it('#21b the carrier carries the PROJECTION destination verifier with exclusive scopes', () => {
    expect(CARRIER).toMatch(/export function verifyProjection/);
    expect(CARRIER).toContain("fail('PROJECTION_MEMBER_MISSING'");
    expect(CARRIER).toContain("fail('PROJECTION_ORPHAN_MEMBER'");
    // NO unreachable/untested code: a scope COUNT comparison is structurally impossible to
    // reach (the missing direction is step 1's PROJECTION_MEMBER_MISSING) so it must not exist.
    expect(CARRIER).not.toContain('PROJECTION_SCOPE_COUNT_MISMATCH');
    // SEAM_A owns TWO exclusive scopes (DBs + ranking pages); SEAM_B owns one (DBs)
    expect(CARRIER).toMatch(/exclusiveScopes: Object\.freeze\(\[\s*\n\s*Object\.freeze\(\{ dir: 'data', re: DB_MEMBER_RE \}\),\s*\n\s*Object\.freeze\(\{ dir: 'cache\/rankings'/);
    expect((CARRIER.match(/exclusiveScopes:/g) || []).length).toBe(2);
    // the projection is deliberately NOT an exact-set walk of the whole workspace
    expect(CARRIER).toContain('verify-projection');
  });

  it('#22 both carriers demand EXACT set equality (min == RANKINGS_DB_COUNT, extras refused)', () => {
    expect(CARRIER).toMatch(/name: 'rankings_db', re: DB_MEMBER_RE, min: RANKINGS_DB_COUNT/);
    expect((CARRIER.match(/exactDbSet: true/g) || []).length).toBe(2);
    expect((CARRIER.match(/assertMemberEligibility: true/g) || []).length).toBe(2);
    expect(CARRIER).toContain("return fail('RANKINGS_DB_SET_EXTRA'");
    expect(CARRIER).toContain("return fail('RANKINGS_DB_SET_MISSING'");
    // SEAM_A additionally floors the ranking page JSONs so the DB set cannot mask them
    expect(CARRIER).toMatch(/name: 'ranking_pages'[^\n]*min: RANKINGS_DB_COUNT/);
    expect(CARRIER).toMatch(/name: 'category_stats'[^\n]*min: 1/);
    // the two carrier prefix roots are distinct and attempt-scoped by derivation only
    expect(CARRIER).toContain("prefixRoot: 'state/_handoff/rankings-satellite'");
    expect(CARRIER).toContain("prefixRoot: 'state/_handoff/rankings-db'");
    expect(CARRIER).toMatch(/return `\$\{root\}\/\$\{producerRunId\}\/attempt-\$\{attempt\}\/`;/);
    // membership is CLASSIFIED (unknown members fail loud), one function for generate+verify
    expect(CARRIER).toMatch(/export function classifyRankingsMember/);
    expect(CARRIER).toContain('UNCLASSIFIED_MEMBER');
    expect(CARRIER).toMatch(/export function listCarrierFiles/);
    // PURE: no R2 / SDK in the manifest core (transport is the frozen generic CLI).
    // Comments may NAME the excluded dependency; no import/require may exist.
    const carrierCode = jsCodeOf(CARRIER);
    expect(carrierCode).not.toContain('@aws-sdk');
    expect(carrierCode).not.toContain("from './lib/r2-handoff.js'");
    expect(carrierCode).not.toContain('r2-workflow-cli');
  });

  it('#23 the exporter enforces the EXACT-10 emission floor and mandatory identity (D11 + D6)', () => {
    expect(EXPORTER).toContain('RANKINGS_GROUP_EMPTY');
    expect(EXPORTER).toContain('RANKINGS_GROUP_UNEXPECTED');
    expect(EXPORTER).toContain('RANKINGS_DB_COUNT_MISMATCH');
    expect(EXPORTER).toContain('RANKINGS_IDENTITY_ENV_INVALID');
    // the failure message must name the offending groups AND the per-group counts
    expect(EXPORTER).toContain('per-group counts');
    // the old silent `continue` on an empty group is gone
    expect(EXPORTER).not.toMatch(/if \(!entitiesIn\.length\) continue;/);
    expect(EXPORTER).not.toMatch(/if \(!entities\.length\) continue;/);
    // RANKINGS_SCHEMA is exported so the verifier can DERIVE its expectations
    expect(EXPORTER).toContain('export const RANKINGS_SCHEMA');
  });

  it('#24 the node --test suite is wired into the explicit blocking list (no wildcard exists)', () => {
    const runLine = SUITE.split('\n').find((l) => l.includes('node --test scripts/factory/aggregate-handoff.test.mjs')) || '';
    expect(runLine).toContain('scripts/factory/rankings-db-handoff-manifest.test.mjs');
    expect(exists('scripts/factory/rankings-db-handoff-manifest.test.mjs')).toBe(true);
    // the .mjs suites are NOT vitest-collected, so the explicit list is the ONLY wiring
    expect(SUITE).toContain('npx vitest run');
  });

  it('#25 the BYTE-FROZEN transport + sibling carriers are untouched by this repair', () => {
    // D-375 -> D-391 transport closure: composed, never edited
    for (const rel of ['scripts/factory/lib/r2-handoff.js', 'scripts/factory/r2-workflow-cli.js']) {
      expect(read(rel)).not.toContain('rankings-db-handoff');
      expect(read(rel)).not.toContain('rankings_db');
    }
    // the cycle-output carrier still declares output/data/ out of scope (cache-only member root)
    const cycle = read('scripts/factory/cycle-output-handoff-manifest.mjs');
    expect(cycle).toMatch(/memberRoots: Object\.freeze\(\[\s*\n\s*Object\.freeze\(\{ dir: 'cache', extensions: null \}\),/);
    expect(cycle).not.toContain('rankings-db');
    // pack-db.js is at the CES 250-line ceiling and gained nothing
    expect(read('scripts/factory/pack-db.js').split('\n').length).toBeLessThanOrEqual(251);
    expect(read('scripts/factory/pack-db.js')).not.toContain('rankings-db-verifier');
    // the other forbidden-to-edit modules carry no rankings-authority coupling
    for (const rel of ['scripts/factory/lib/upload-eligibility.js', 'scripts/factory/r2-upload-s3.js', 'scripts/factory/verify-db.js']) {
      expect(read(rel)).not.toContain('rankings-db-verifier');
      expect(read(rel)).not.toContain('rankings-db-handoff');
    }
    // verify-db.js still SKIPS rankings-* (the new verifier is the rankings authority)
    expect(read('.github/workflows/factory-upload.yml')).toContain('case "$(basename "$db")" in rankings-*)');
  });
});
