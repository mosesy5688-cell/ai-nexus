/**
 * SRS-1 — Open-model metadata-normalization transparency doc honesty
 * (tier-1, hermetic). D-2026-0712-328 / Option A.
 *
 * Locks the bounded transparency documentation shipped in developers.astro
 * (#model-metadata-normalization section) + the published JSON asset
 * public/data/model-metadata-normalization-example.json to the currently-
 * implemented truth. This is a DOCUMENTATION / CONTRACT-PROJECTION guard, NOT a
 * behavior test: it reads the developers.astro SOURCE and JSON.parse's the
 * static asset. No live fetch. Deterministic across runs.
 *
 * The negated honest sentences MUST PASS:
 *   - "safetensors.total is a source-reported parameter count, not file bytes"
 *   - "Cross-source entity fusion is not implemented"
 * The affirmative-false patterns (T9 byte-conversion, T13 fusion-enabled) are
 * anchored so they reject ONLY affirmative false claims and NEVER match those
 * correct negations. Anti-vacuity M1/M2/M3 are proven empirically by the
 * implementer (mutate -> RED -> restore); documented in the PR body.
 *
 * NOTE (scope): "exactly four changed files", "no new API endpoint", "no SDK
 * version change", "no API/MCP/Factory/FNI code touched" are PM git-diff/scope
 * audit items, NOT source-only unit assertions, and are intentionally NOT here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const abs = (rel: string) => resolve(root, rel);

const DEV = readFileSync(abs('src/pages/developers.astro'), 'utf8');
const ASSET_PATH = abs('public/data/model-metadata-normalization-example.json');
const ASSET_RAW = readFileSync(ASSET_PATH); // Buffer -> real byte size
const ASSET_TEXT = ASSET_RAW.toString('utf8');

// --- helpers ---------------------------------------------------------------
// Longest primitive (string/number/bool/null) array anywhere in the tree. This
// is the anti-"large source/model-card dump" guard: a full HF tags/languages/
// siblings/spaces array (all string primitives, ~100 long) trips it. Arrays of
// OBJECTS (field_mappings=17, known_limitations=7) are the doc's own structure
// and are intentionally exempt — the gate cap targets copied source arrays.
function maxPrimitiveArrayLen(o: unknown): number {
  let m = 0;
  if (Array.isArray(o)) {
    if (o.every((x) => x === null || typeof x !== 'object')) m = Math.max(m, o.length);
    for (const x of o) m = Math.max(m, maxPrimitiveArrayLen(x));
  } else if (o && typeof o === 'object') {
    for (const v of Object.values(o as Record<string, unknown>)) m = Math.max(m, maxPrimitiveArrayLen(v));
  }
  return m;
}
function maxStringLen(o: unknown): number {
  let m = 0;
  if (typeof o === 'string') return o.length;
  if (Array.isArray(o)) for (const x of o) m = Math.max(m, maxStringLen(x));
  else if (o && typeof o === 'object') for (const v of Object.values(o as Record<string, unknown>)) m = Math.max(m, maxStringLen(v));
  return m;
}

const APPROVED_VOCABULARY = [
  'SOURCE_RETAINED', 'NORMALIZED', 'DERIVED', 'ESTIMATED',
  'SOURCE_UNAVAILABLE', 'DROPPED_BY_CURRENT_PIPELINE', 'KNOWN_DEFECT',
];

describe('SRS-1 metadata-normalization: JSON asset structural honesty', () => {
  let asset: any;
  it('T1: JSON parses and byte size <= 12288', () => {
    asset = JSON.parse(ASSET_TEXT);
    expect(asset).toBeTruthy();
    expect(ASSET_RAW.length).toBeLessThanOrEqual(12288);
  });

  it('T2: no large source/model-card arrays or provider prose', () => {
    const a = asset ?? JSON.parse(ASSET_TEXT);
    expect(maxPrimitiveArrayLen(a)).toBeLessThanOrEqual(12);
    expect(maxStringLen(a)).toBeLessThanOrEqual(600);
  });

  it('T3: example markers assert not-normative / not-adoption', () => {
    const a = JSON.parse(ASSET_TEXT);
    expect(a.example_type).toBe('OBSERVED_TRANSFORMATION_EXAMPLE');
    expect(a.not_a_normative_schema).toBe(true);
    expect(a.not_adoption_evidence).toBe(true);
  });

  it('T4: classification_vocabulary deep-equals exactly the 7 approved values', () => {
    const a = JSON.parse(ASSET_TEXT);
    expect(a.classification_vocabulary).toEqual(APPROVED_VOCABULARY);
  });

  it('T5: classifications_used == exact unique set of field_mappings classifications', () => {
    const a = JSON.parse(ASSET_TEXT);
    const usedInMappings = new Set(a.field_mappings.map((m: any) => m.classification));
    const declared = new Set(a.classifications_used_in_this_example);
    // set-equality (order-independent) + no duplicates in the declared list
    expect(declared).toEqual(usedInMappings);
    expect(a.classifications_used_in_this_example.length).toBe(declared.size);
    // D-328 #4: this record uses 6 of the 7 defined classes; ESTIMATED is
    // DEFINED but NOT used (no field is forced to fill it).
    expect(declared.size).toBe(6);
    expect(declared.has('ESTIMATED')).toBe(false);
    expect(a.classification_vocabulary).toContain('ESTIMATED');
  });

  it('T6: every field_mappings classification is a member of the vocabulary', () => {
    const a = JSON.parse(ASSET_TEXT);
    for (const m of a.field_mappings) {
      expect(a.classification_vocabulary).toContain(m.classification);
    }
  });

  it('T7: separate source + F2AI + generated observation timestamps present + ISO-8601', () => {
    const a = JSON.parse(ASSET_TEXT);
    for (const k of ['source_observed_at_utc', 'free2aitools_observed_at_utc', 'example_generated_at_utc']) {
      expect(typeof a[k]).toBe('string');
      expect(a[k]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(Number.isNaN(Date.parse(a[k]))).toBe(false);
    }
    // The source + F2AI timestamps are SPLIT into distinct fields (D-328 #5),
    // not a single shared observation stamp.
    expect(Object.prototype.hasOwnProperty.call(a, 'source_observed_at_utc')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(a, 'free2aitools_observed_at_utc')).toBe(true);
    expect(a.observation_note).toMatch(/downloads/i);
  });

  it('T15: G1/G3/G4/G5/G6/G7/G14 present, OPEN, and their summaries surfaced on the page', () => {
    const a = JSON.parse(ASSET_TEXT);
    const refs = a.known_limitations.map((k: any) => k.audit_ref);
    for (const g of ['G1', 'G3', 'G4', 'G5', 'G6', 'G7', 'G14']) {
      expect(refs).toContain(g);
      const entry = a.known_limitations.find((k: any) => k.audit_ref === g);
      expect(entry.status).toBe('OPEN_AT_OBSERVATION_TIME');
      expect(typeof entry.summary).toBe('string');
      expect(entry.summary.length).toBeGreaterThan(0);
      // The SAME summary text is rendered on the developers.astro page.
      expect(DEV.includes(entry.summary)).toBe(true);
    }
  });
});

describe('SRS-1 metadata-normalization: developers.astro public-copy honesty', () => {
  // T8: exact-substring (NOT a regex) — the safetensors parameter-count sentence.
  const SAFETENSORS_SENTENCE = 'safetensors.total is a source-reported parameter count, not file bytes';
  // T9: affirmative byte-conversion pattern, anchored to NOT match the negated
  // ".total is a ... count, not file bytes" sentence ("safetensors" is followed
  // by "." which the [^.\n] class cannot cross, so the negation always passes).
  const AFFIRMATIVE_BYTES = /safetensors[^.\n]{0,40}\b(is|=|in)\b[^.\n]{0,20}\bbytes\b/i;
  // T12/T13: the negated fusion sentence + the affirmative fusion-enabled pattern
  // anchored so "...fusion is not implemented" is NEVER matched.
  const FUSION_NEGATED = 'Cross-source entity fusion is not implemented';
  const FUSION_POSITIVE = /cross-source\s+(entity\s+)?fusion\s+is\s+(now\s+)?(implemented|enabled|available|supported)/i;
  // T10: exact-substring qualified source-boundary sentence.
  const QUALIFIED_BOUNDARY = 'source-attributed and source-qualified normalization, with known projection losses in the current implementation';
  // T11: forbidden affirmative claims — built by concatenation so the contiguous
  // forbidden phrase never appears literally in this test source, while the
  // runtime needle equals the full phrase (gate: forbidden literals not in test).
  const FORBIDDEN_AFFIRMATIONS = [
    'fully ' + 'curated',
    'objective ' + 'truth',
    'verified ' + 'truth',
    'complete source ' + 'retention',
    'We attribute every field ' + 'to its source',
    'no monolith risk ' + 'at any length',
    'zero monolith ' + 'risk',
  ];

  it('T8: the exact safetensors parameter-count sentence is present', () => {
    expect(DEV.includes(SAFETENSORS_SENTENCE)).toBe(true);
  });

  it('T9: affirmative false byte-conversion claims are absent (negation passes)', () => {
    expect(AFFIRMATIVE_BYTES.test(DEV)).toBe(false);
    // Sanity: the correct negated sentence must NOT be matched by the pattern.
    expect(AFFIRMATIVE_BYTES.test(SAFETENSORS_SENTENCE)).toBe(false);
    // Sanity: a genuine affirmative byte claim WOULD be caught.
    expect(AFFIRMATIVE_BYTES.test('safetensors total is the model size in bytes')).toBe(true);
  });

  it('T10: the exact qualified source-boundary sentence is present', () => {
    expect(DEV.includes(QUALIFIED_BOUNDARY)).toBe(true);
  });

  it('T11: affirmative complete-retention / false claims are absent', () => {
    for (const phrase of FORBIDDEN_AFFIRMATIONS) {
      expect(DEV.includes(phrase), `developers.astro must not contain "${phrase}"`).toBe(false);
      expect(ASSET_TEXT.includes(phrase), `asset must not contain "${phrase}"`).toBe(false);
    }
  });

  it('T12: the exact "Cross-source entity fusion is not implemented" sentence is present', () => {
    expect(DEV.includes(FUSION_NEGATED)).toBe(true);
  });

  it('T13: positive fusion-enabled claims are absent (negation passes)', () => {
    expect(FUSION_POSITIVE.test(DEV)).toBe(false);
    // Sanity: the correct negated sentence must NOT be matched by the pattern.
    expect(FUSION_POSITIVE.test(FUSION_NEGATED)).toBe(false);
    // Sanity: a genuine affirmative fusion claim WOULD be caught.
    expect(FUSION_POSITIVE.test('Cross-source entity fusion is now implemented')).toBe(true);
  });

  it('T14: caller-decides + FNI-not-truth + current fni_s-null contract present', () => {
    expect(DEV.includes('The caller decides')).toBe(true);
    expect(DEV.includes('not truth')).toBe(true);
    expect(DEV.includes('fni_s is currently null')).toBe(true);
  });

  it('section is anchored + quick-linked + references the JSON asset', () => {
    expect(DEV.includes('id="model-metadata-normalization"')).toBe(true);
    expect(DEV.includes('href="#model-metadata-normalization"')).toBe(true);
    expect(DEV.includes('/data/model-metadata-normalization-example.json')).toBe(true);
  });
});
