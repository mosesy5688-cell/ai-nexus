// tests/srs1/factory-handoff-guard-classification-invariant.test.ts
//
// SRS-1 Tier-1 HERMETIC anti-one-seam gate for the backend handoff
// manifest/upload-guard divergence class (Founder D-2026-0706-285, PR-D, the
// FINAL repair-train PR). PR-A/B/C fixed the individual carriers; THIS gate stops
// the class recurring a THIRD time by forcing EVERY per-file backend handoff
// descriptor generator to be classified as EXACTLY ONE of six categories, and by
// DISCOVERING generators from disk (not a hardcoded list) so a NEW unregistered
// generator, or a registered generator that LOSES its category evidence, fails CI.
//   1 SHARED_PREDICATE_PLUS_ASSERT      - imports shared isUploadEligible + a
//                                         generate-time member-eligibility assert
//                                         (MEMBER_UPLOAD_INELIGIBLE); BOTH idioms
//                                         (assertMemberEligibility/bypassRe flag AND
//                                         inline isUploadEligible()+throw) accepted.
//   2 EXPLICIT_CLASS_MEMBERSHIP_REGISTRY- classifies members + drops excluded classes.
//   3 UPLOAD_FILE_OR_UPLOAD_BUFFER_BYPASS - members reach R2 via a documented bypass verb.
//   4 SINGLE_ARCHIVE_IMMUNE             - ONE archive, uploaded whole via putObject,
//                                         verified by archive_sha256 (not per-file exposed).
//   5 DOCUMENTED_DIFFERENT_RISK_CLASS   - not this divergence class (registry/D-250
//                                         count-floor; cluster-ann-index.bin coverage gap).
//   6 DOCUMENTED_INSUFFICIENT_EVIDENCE_NEEDS_FOUNDER.
// Reads repo SOURCE as TEXT (CRLF-normalized; NO network, NO workflow run, NO prod).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const FACTORY = path.resolve(__dirname, '../../scripts/factory');
const read = (f: string) => fs.readFileSync(path.join(FACTORY, f), 'utf8').replace(/\r\n/g, '\n');

// DISCOVERY (anti-one-seam): every top-level scripts/factory/*handoff*.{js,mjs}
// (readdirSync is non-recursive, so the SHARED lib/r2-handoff.js uploader/consumer
// is correctly NOT a per-file descriptor generator and is excluded), minus tests.
const DISCOVERED = fs
  .readdirSync(FACTORY)
  .filter((f) => /handoff/.test(f) && /\.m?js$/.test(f) && !/\.test\./.test(f))
  .sort();

type Cat = 1 | 2 | 3 | 4 | 5 | 6;
interface Gen { file: string; category: Cat; alsoCategory?: Cat; note: string }
// CANONICAL CLASSIFICATION REGISTRY - the anti-one-seam ledger. A discovered
// generator absent here FAILS (a future dev MUST classify a new handoff generator).
const REGISTRY: Gen[] = [
  { file: 'shards-handoff-manifest.mjs', category: 1, note: 'shared isUploadEligible import + assertMemberEligibility generate-time assert' },
  { file: 'cycle-output-handoff-manifest.mjs', category: 1, alsoCategory: 2, note: 'shared predicate + assert; ALSO classifyCycleMember/EXCLUDED_CLASSES registry (cat 2)' },
  { file: 'mesh-profile-handoff-manifest.mjs', category: 1, note: 'shared predicate + bypassRe-guarded assert (one documented cat-3 bypass member)' },
  { file: 'fused-handoff-manifest.js', category: 1, note: 'shared predicate + inline isUploadEligible()+throw MEMBER_UPLOAD_INELIGIBLE idiom' },
  { file: 'vfs-derived-handoff-manifest.mjs', category: 1, note: 'shared predicate + assertMemberEligibility (Pack members + warm_read)' },
  { file: 'aggregate-handoff.mjs', category: 4, note: 'single handoff.tar.zst archive, putObject whole, archive_sha256-verified' },
  { file: 'harvest-authoritative-handoff.mjs', category: 4, note: 'per-role single <role>.tar.zst archive, putObject, archive_sha256' },
  { file: 'satellite-registry-handoff.mjs', category: 4, note: 'single registry.tar.zst archive, putObject, archive_sha256' },
];

// DIFFERENT-RISK sweep carriers with NO per-file handoff manifest generator to
// scan - documented (cat 5) so they are never silently forgotten by the gate.
interface Risk { id: string; category: 5; doc: string }
const DIFFERENT_RISK: Risk[] = [
  { id: 'registry/D-250', category: 5, doc: 'count-floor silent-subset risk (master-fusion-compute registry freshness); NOT the per-file manifest/upload-guard divergence class; no per-file handoff manifest generator exists for it.' },
  { id: 'output/data/cluster-ann-index.bin', category: 5, doc: 'warm-tier .bin excluded from AUTH-W authority AND from vfs-derived manifest membership (foreign .bin ignored); coverage-gap risk class; no per-file handoff manifest generator.' },
];

// ---- Category evidence predicates (read the SOURCE, not the registry note) ----
const IMPORT_RE = /import\s*\{[^}]*\bisUploadEligible\b[^}]*\}\s*from\s*['"][^'"]*upload-eligibility[^'"]*['"]/;
const CALL_RE = /\bisUploadEligible\s*\(/; // a CALL (paren) - the import has no paren
const THROW_RE = /throw\s+new\s+[A-Za-z]+\s*\(\s*[`'"]MEMBER_UPLOAD_INELIGIBLE/; // a THROW, never a comment
function cat1Evidence(src: string) {
  return { hasImport: IMPORT_RE.test(src), hasCall: CALL_RE.test(src), hasThrow: THROW_RE.test(src) };
}
const PUT_RE = /\.putObject\s*\(/;
const BUILD_RE = /buildArchive\s*\(/;
function cat4Evidence(src: string) {
  return {
    hasPut: PUT_RE.test(src),
    hasSha: /archive_sha256/.test(src),
    hasBuild: BUILD_RE.test(src),
    noPerFileGuard: !/upload-eligibility/.test(src) && !/backup-dir/.test(src),
  };
}
const byCat = (c: Cat) => REGISTRY.filter((g) => g.category === c);

// STRUCTURAL discovery cross-check (filename-INDEPENDENT): the /handoff/ filename
// key above could be dodged by a future in-class generator NOT named *-handoff-*
// (review-proven escape). This idiom scan enumerates EVERY scripts/factory/*.{js,mjs}
// (non-recursive => lib/ excluded; no tests) and flags the GENERATOR IDIOM. Verified
// to match EXACTLY the 8 registered generators with ZERO false positives: manifest
// generators carry the `carrier_type` schema field and/or an exported generateManifest();
// archive generators carry buildArchive()+archive_sha256. Non-generators
// (r2-workflow-cli.js [await-imports gens + a generic backup-dir CLI verb],
// migrate-fni-history-vault.js [backup-dir only in a comment], master-fusion.js,
// verify-db.js, aggregator.js, pack-db.js, ...) carry NONE of these markers.
const ALL_FACTORY = fs.readdirSync(FACTORY).filter((f) => /\.m?js$/.test(f) && !/\.test\./.test(f));
const GEN_IDIOM = (src: string) =>
  /carrier_type/.test(src) ||
  /export\s+(?:async\s+)?function\s+generateManifest\s*\(/.test(src) ||
  (BUILD_RE.test(src) && /archive_sha256/.test(src));
const IDIOM_MATCHED = ALL_FACTORY.filter((f) => GEN_IDIOM(read(f))).sort();

describe('handoff-generator DISCOVERY <-> registry bijection (anti-one-seam completeness)', () => {
  it('sanity: the sweep carriers are all discovered (>= the 8 known generators)', () => {
    expect(DISCOVERED.length).toBeGreaterThanOrEqual(8);
    for (const g of REGISTRY) expect(DISCOVERED, `registered ${g.file} must be on disk`).toContain(g.file);
  });

  it('EVERY discovered handoff generator is registered (a new unregistered generator FAILS)', () => {
    const registered = new Set(REGISTRY.map((g) => g.file));
    const unregistered = DISCOVERED.filter((f) => !registered.has(f));
    expect(unregistered, `unclassified handoff generator(s) on disk - classify in REGISTRY: ${unregistered.join(', ')}`).toEqual([]);
  });

  it('the registry references NO phantom generator (every registered file exists)', () => {
    for (const g of REGISTRY) expect(fs.existsSync(path.join(FACTORY, g.file)), `${g.file} missing`).toBe(true);
    expect(REGISTRY.length).toBe(DISCOVERED.length); // exact bijection - no stale, no missing
  });

  it('every registry generator has exactly one primary category in the closed 1..6 set', () => {
    for (const g of REGISTRY) expect([1, 2, 3, 4, 5, 6]).toContain(g.category);
    expect(new Set(REGISTRY.map((g) => g.file)).size).toBe(REGISTRY.length); // no dup key
  });
});

describe('STRUCTURAL idiom discovery cross-check (filename-independent; closes the naming escape)', () => {
  it('the generator IDIOM matches EXACTLY the 8 registered generators (zero false positives)', () => {
    const registeredFiles = REGISTRY.map((g) => g.file).sort();
    // If a non-generator (r2-workflow-cli.js etc) were flagged, this set would differ.
    expect(IDIOM_MATCHED).toEqual(registeredFiles);
  });

  it('EVERY idiom-matched generator is filename-discovered AND registered (a non-*handoff*-named generator FAILS)', () => {
    const discovered = new Set(DISCOVERED);
    const registered = new Set(REGISTRY.map((g) => g.file));
    for (const f of IDIOM_MATCHED) {
      expect(discovered.has(f), `${f} carries the generator idiom but is NOT filename-discovered (rename to *-handoff-* OR extend discovery)`).toBe(true);
      expect(registered.has(f), `${f} carries the generator idiom but is NOT in the REGISTRY - classify it`).toBe(true);
    }
  });
});

describe('category-1 SHARED_PREDICATE_PLUS_ASSERT evidence (both idioms; removed assert FAILS)', () => {
  it('each cat-1 generator imports the shared predicate AND has a generate-time member-eligibility assert', () => {
    for (const g of byCat(1)) {
      const e = cat1Evidence(read(g.file));
      expect(e.hasImport, `${g.file} must import shared isUploadEligible`).toBe(true);
      // generate-time assert = a real isUploadEligible() CALL feeding a real
      // throw MEMBER_UPLOAD_INELIGIBLE. Covers BOTH idioms: the assertMemberEligibility/
      // bypassRe flag path (shards/cycle-output/mesh/vfs-derived) AND the inline
      // isUploadEligible()+throw path (fused). Losing either token turns this RED.
      expect(e.hasCall, `${g.file} must CALL isUploadEligible at generate time`).toBe(true);
      expect(e.hasThrow, `${g.file} must THROW MEMBER_UPLOAD_INELIGIBLE (fail-loud assert)`).toBe(true);
    }
  });

  it('cycle-output ALSO carries the explicit class-membership registry (its cat-2 tag)', () => {
    const cyc = REGISTRY.find((g) => g.file === 'cycle-output-handoff-manifest.mjs')!;
    expect(cyc.alsoCategory).toBe(2);
    const src = read(cyc.file);
    expect(src).toMatch(/classifyCycleMember/);
    expect(src).toMatch(/EXCLUDED_CLASSES/);
  });

  it('NON-VACUITY: stripping the generate-time assert from a cat-1 source flips its evidence RED', () => {
    const src = read('shards-handoff-manifest.mjs');
    expect(cat1Evidence(src).hasThrow).toBe(true);
    const stripped = src
      .split('\n')
      .filter((l) => !/MEMBER_UPLOAD_INELIGIBLE/.test(l) && !/isUploadEligible\s*\(/.test(l))
      .join('\n');
    const e = cat1Evidence(stripped);
    expect(e.hasThrow).toBe(false);
    expect(e.hasCall).toBe(false); // the evidence genuinely depends on the assert, not on a comment
  });
});

describe('category-4 SINGLE_ARCHIVE_IMMUNE evidence (one archive uploaded whole; no per-file guard)', () => {
  it('each cat-4 generator builds ONE archive uploaded via putObject + verified by archive_sha256', () => {
    for (const g of byCat(4)) {
      const e = cat4Evidence(read(g.file));
      expect(e.hasBuild, `${g.file} must buildArchive`).toBe(true);
      expect(e.hasPut, `${g.file} must putObject the whole archive`).toBe(true);
      expect(e.hasSha, `${g.file} must verify archive_sha256`).toBe(true);
      // structurally NOT per-file-guard-exposed: it does not import the per-file
      // eligibility predicate nor use a per-file backup-dir member upload verb.
      expect(e.noPerFileGuard, `${g.file} must NOT expose per-file members to the upload guard`).toBe(true);
    }
  });

  it('NON-VACUITY: the cat-4 predicate rejects a source that imports the per-file guard', () => {
    const faux = read('aggregate-handoff.mjs') + "\nimport { isUploadEligible } from './lib/upload-eligibility.js';\n";
    expect(cat4Evidence(faux).noPerFileGuard).toBe(false);
  });
});

describe('DIFFERENT-RISK carriers are registered cat-5 (documented, not silently forgotten)', () => {
  it('each different-risk carrier is cat-5 with a non-empty documentation string', () => {
    expect(DIFFERENT_RISK.length).toBeGreaterThanOrEqual(2);
    for (const r of DIFFERENT_RISK) {
      expect(r.category).toBe(5);
      expect(r.doc.length).toBeGreaterThan(40);
    }
  });

  it('the different-risk carriers correctly have NO per-file handoff manifest generator on disk', () => {
    for (const r of DIFFERENT_RISK) {
      const stem = path.basename(r.id).replace(/\.[a-z]+$/, '');
      const gen = DISCOVERED.find((f) => f.includes(stem) && /manifest/.test(f));
      expect(gen, `${r.id} unexpectedly has a manifest generator ${gen}`).toBeUndefined();
    }
  });
});

describe('NON-VACUITY: the completeness ledger flags an unregistered discovered generator', () => {
  it('a hypothetical new *-handoff-manifest.mjs would be reported unregistered', () => {
    const fakeDiscovered = [...DISCOVERED, 'zzz-future-handoff-manifest.mjs'].sort();
    const registered = new Set(REGISTRY.map((g) => g.file));
    const unregistered = fakeDiscovered.filter((f) => !registered.has(f));
    expect(unregistered).toContain('zzz-future-handoff-manifest.mjs');
  });
});
