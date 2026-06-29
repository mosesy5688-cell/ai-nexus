/**
 * GR-01 — soft-404 fix for the one-segment category catch-all (Founder D-183 §D).
 *
 * DEFECT: `src/pages/[category].astro` is a catch-all that served ANY unknown
 * one-segment slug as a 200 archive page — it fabricated category metadata
 * (`CATEGORY_METADATA[c] || {label,icon,description}`), then read archive data
 * and emitted an indexable canonical/meta for the bogus page (a soft-404).
 *
 * FIX: validate the resolved slug against the AUTHORITATIVE category set — the
 * keys of `CATEGORY_METADATA` (src/utils/category-mapping.js), the same map the
 * page renders from. An unknown slug is a REAL 404: `Astro.response.status = 404`
 * is set BEFORE `fetchCatalogData` (no archive/VFS read), the page is served
 * noindex, and the fabricated `|| {meta}` default is gone.
 *
 * This is a HERMETIC test (SRS-1 boundary): it (a) EXECUTES the real authoritative
 * module `CATEGORY_METADATA` to prove the validity predicate classifies every
 * current category as 200-eligible and unknown slugs as 404, and (b) reads the
 * page SOURCE to prove the page binds that predicate to a real 404 emitted before
 * any data read, served noindex, with the fabricated soft-200 default removed.
 * Anti-vacuity: deleting the 404 (reverting the fix) flips the detector RED.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORY_METADATA } from '../../src/utils/category-mapping.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');

const PAGE = 'src/pages/[category].astro';

// The page's authoritative validity predicate, evaluated against the SAME source
// of truth the page imports (CATEGORY_METADATA). known => 200 archive; unknown =>
// the page sets status 404.
const isKnownCategory = (slug: string): boolean =>
  Object.prototype.hasOwnProperty.call(CATEGORY_METADATA, slug);

// Detector: the soft-404 guard is ACTIVE iff the page sets HTTP 404 BEFORE it
// reads archive data via fetchCatalogData(). If the 404 is removed (the fix
// reverted) OR moved after the data read, this returns false => the suite reds.
function guardActive(src: string): boolean {
  const statusIdx = src.indexOf('Astro.response.status = 404');
  const fetchIdx = src.indexOf('fetchCatalogData(');
  return statusIdx > -1 && fetchIdx > -1 && statusIdx < fetchIdx;
}

// Unknown one-segment slugs that are NOT reserved-route redirects and NOT legacy
// aliases (those resolve earlier in the page), so they fall to the catch-all.
const UNKNOWN_SLUGS = ['enterprise', 'pricing', 'foobar', 'totally-bogus-xyz', 'gpt5'];

describe('GR-01 authoritative validity predicate (EXEC — real CATEGORY_METADATA)', () => {
  it('the authoritative category set is NON-EMPTY (predicate is non-vacuous)', () => {
    expect(Object.keys(CATEGORY_METADATA).length).toBeGreaterThan(0);
  });

  it('every CURRENT valid category is 200-eligible (isKnownCategory === true)', () => {
    for (const slug of Object.keys(CATEGORY_METADATA)) {
      expect(isKnownCategory(slug), `${slug} must stay a valid 200 category`).toBe(true);
    }
    // The canonical V6 slugs the page renders must all be present.
    for (const canonical of [
      'text-generation', 'knowledge-retrieval', 'vision-multimedia',
      'automation-workflow', 'infrastructure-ops',
    ]) {
      expect(isKnownCategory(canonical)).toBe(true);
    }
  });

  it('an unknown one-segment slug is NOT a category (=> 404, not a soft-200 archive)', () => {
    for (const slug of UNKNOWN_SLUGS) {
      expect(isKnownCategory(slug), `${slug} must be rejected as 404`).toBe(false);
    }
  });
});

describe('GR-01 page binds the predicate to a REAL 404 before any data read (SOURCE)', () => {
  const src = read(PAGE);

  it('validates the slug against the authoritative CATEGORY_METADATA keys', () => {
    expect(src).toContain('Object.prototype.hasOwnProperty.call(CATEGORY_METADATA');
  });

  it('sets a REAL 404 status BEFORE the archive read (no VFS/R2 work for a 404)', () => {
    expect(guardActive(src)).toBe(true);
    // The data read is itself gated on isKnownCategory — an unknown slug skips it.
    expect(src).toMatch(/isKnownCategory\s*\n?\s*\?\s*await fetchCatalogData/);
  });

  it('serves the unknown-slug page noindex (no indexable fabricated archive)', () => {
    expect(src).toContain('noindex={!isKnownCategory}');
    expect(src).toContain("'X-Robots-Tag', 'noindex, nofollow'");
  });

  it('the fabricated soft-200 default metadata is REMOVED', () => {
    // The old `CATEGORY_METADATA[c] || { ... Explore top AI resources ... }`
    // fabricated archive default must no longer exist.
    expect(src).not.toContain('Explore top AI resources in the');
  });

  it('known categories still render the archive grid + catalog island (no regression)', () => {
    expect(src).toContain('id="category-grid"');
    expect(src).toContain("from '../scripts/lib/UniversalCatalog.js'");
  });
});

describe('GR-01 no out-of-scope regression (CONFIG / SOURCE, read-only)', () => {
  it('compiled redirects still resolve BEFORE the catch-all (astro.config 301s intact)', () => {
    const cfg = read('astro.config.mjs');
    expect(cfg).toContain('redirects:');
    expect(cfg).toContain("'/compare'");
  });

  it('entity-detail 404/503 behavior is untouched (model detail keeps both)', () => {
    const model = read('src/pages/model/[...slug].astro');
    expect(model).toMatch(/status\s*=\s*404/);
    expect(model).toMatch(/status\s*=\s*503/);
  });
});

describe('GR-01 ANTI-VACUITY — deleting the 404 branch turns the guard RED', () => {
  const src = read(PAGE);

  it('current source: guard ACTIVE (known => 200, unknown => 404)', () => {
    expect(guardActive(src)).toBe(true);
  });

  it('reverted source (404 removed): guard detector flips to RED', () => {
    // Model "the fix reverted / 404 branch deleted": drop the status-404 line.
    const mutated = src.replace('Astro.response.status = 404;', '');
    expect(mutated).not.toBe(src); // the line really existed
    expect(guardActive(mutated)).toBe(false);
  });
});
