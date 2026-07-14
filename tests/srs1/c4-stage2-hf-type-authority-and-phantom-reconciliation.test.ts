/**
 * SRS-1 - C4 Stage-2 (Founder D-333/334/335/336): source-family-authoritative HF identity
 * type (Commit A) + narrow candidate-universe phantom reconciliation (Commit B). Tier-1,
 * HERMETIC. Carries M1-M12 + type-authority + narrow predicate + genuine-dual + private/
 * stale retention + ID/UMID stability + ledger/count reconciliation. M13-M21 + the census
 * pagination / freeze / drift / production-path live in the sibling candidate-universe file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { HuggingFaceAdapter } from '../../scripts/ingestion/adapters/huggingface-adapter.js';
import { DatasetsAdapter } from '../../scripts/ingestion/adapters/datasets-adapter.js';
import { inferType } from '../../scripts/ingestion/adapters/hf-utils.js';
import { modelSourceEntityType, sourceTypeDiagnostic } from '../../scripts/ingestion/adapters/hf-relation-extractors.js';
import { resolveIdentityType } from '../../scripts/factory/lib/registry-manager.js';
import { projectEntity } from '../../scripts/factory/lib/registry-loader.js';
import { buildEntityRow } from '../../scripts/factory/lib/row-builders.js';
import { normalizeId, getNodeSource } from '../../scripts/utils/id-normalizer.js';
import { classifyPhantoms, verifyPreFusionGate, verifyPostPackGate, EVIDENCE_CLASS as EC } from '../../scripts/factory/lib/hf-phantom-reconciler.js';
import { freezeCandidateUniverse, verifyUniverseHash, buildAuthorityArtifact, AUTHORITY_ROLE, resolveCascadeTuple, cascadeTupleKey, censusSkipGuardVerdict, CASCADE_TUPLE_FOREIGN as CFOREIGN, CASCADE_TUPLE_MISSING as CMISSING, CENSUS_SKIP_FORBIDDEN as CENSUS_SKIP, COMPLETE_FOR_C4_STAGE2_CANDIDATE_UNIVERSE as OK } from '../../scripts/factory/lib/c4s2-candidate-universe.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rawModel = (o: any = {}): any => ({ modelId: 'acme/widget', id: 'acme/widget', readme: '# W', tags: ['pytorch'], cardData: {}, config: {}, pipeline_tag: 'text-generation', library_name: 'transformers', likes: 5, downloads: 100, createdAt: '2024-01-01', lastModified: '2024-02-01', siblings: [], ...o });
const rawDataset = (o: any = {}): any => ({ id: 'acme/corpus', author: 'acme', readme: '# C', tags: [], cardData: { license: 'mit', language: ['en'] }, downloads: 42, likes: 3, createdAt: '2024-01-01', lastModified: '2024-02-01', _schemaData: null, _extractedAssets: [], ...o });

// ===========================================================================
// COMMIT A - SOURCE TYPE AUTHORITY (HF model source => identity ALWAYS 'model')
// ===========================================================================
describe('C4-S2 Commit A - source-family-authoritative HF identity type', () => {
  const hf = new HuggingFaceAdapter();
  it('[M1] cardData.datasets on a model stays identity=model (no dataset phantom)', () => {
    expect(inferType(rawModel({ cardData: { datasets: ['squad'] } }))).toBe('dataset');
    const e = hf.normalize(rawModel({ cardData: { datasets: ['squad', 'glue'] } }));
    expect(e.type).toBe('model'); expect(e.source_entity_type).toBe('model'); expect(e.id.startsWith('hf-model--')).toBe(true);
  });
  it('[M2] pipeline_tag==="dataset" on a model does NOT mint a dataset identity', () => {
    const e = hf.normalize(rawModel({ pipeline_tag: 'dataset' }));
    expect(e.type).toBe('model'); expect(e.source_entity_type).toBe('model');
  });
  it('[M3] transformers-no-pipeline HF model now mints identity=model (prospective model->tool prevention)', () => {
    const raw = rawModel({ pipeline_tag: '', library_name: 'transformers', cardData: {} });
    expect(inferType(raw)).toBe('tool');             // descriptive verdict unchanged
    expect(modelSourceEntityType(raw)).toBe('model'); // identity is ALWAYS model
    const e = hf.normalize(raw);
    expect(e.type).toBe('model'); expect(e.id.startsWith('hf-tool--')).toBe(false);
  });
  it('[regressions] ordinary model=model; dataset adapter=dataset', () => {
    const m = hf.normalize(rawModel()); expect(m.type).toBe('model'); expect(m.id).toBe('hf-model--acme--widget');
    const d = new DatasetsAdapter().normalize(rawDataset()); expect(d.type).toBe('dataset'); expect(d.source_entity_type).toBe('dataset');
  });
  it('[M4] the canonical-id mint derives from the immutable family, not inferType', () => {
    const e = hf.normalize(rawModel({ cardData: { datasets: ['squad'] } }));
    const t = resolveIdentityType(e); expect(t).toBe('model');
    expect(normalizeId(e.id, getNodeSource(e.id, t), t)).toBe('hf-model--acme--widget');
    expect(resolveIdentityType({ source_entity_type: 'model', type: 'dataset' })).toBe('model');
  });
  it('[M5] resolveIdentityType: model family ALWAYS model; dataset immutable; legacy passthrough', () => {
    const t = (o: any) => resolveIdentityType(o);
    expect([t({ source_entity_type: 'model', type: 'model' }), t({ source_entity_type: 'model', type: 'dataset' }), t({ source_entity_type: 'model', type: 'tool' }), t({ source_entity_type: 'dataset', type: 'model' }), t({ type: 'tool' }), t({ type: 'dataset' })]).toEqual(['model', 'model', 'model', 'dataset', 'tool', 'dataset']);
  });
  it('[model-tool-axis] model<->tool disagreement is informational only (residual, report-only)', () => {
    expect(sourceTypeDiagnostic(rawModel({ pipeline_tag: '', library_name: 'transformers', cardData: {} }))).toMatchObject({ axis: 'model-tool', identity_type: 'model' });
    expect(sourceTypeDiagnostic(rawModel({ cardData: { datasets: ['squad'] } })).axis).toBe('model-dataset');
    expect(sourceTypeDiagnostic(rawModel()).axis).toBe('none');
  });
  it('[M12] source_entity_type is INTERNAL ONLY - never on a public/packed surface', () => {
    const CANARY = 'SRC_ENTITY_TYPE_LEAK_CANARY';
    const e: any = { id: 'hf-model--a--b', umid: 'u', slug: 'a-b', name: 'b', type: 'model', author: 'a', description: 'd', source_entity_type: CANARY };
    const slim: any = projectEntity(e, true);
    expect('source_entity_type' in slim).toBe(false); expect(Object.values(slim)).not.toContain(CANARY);
    expect(buildEntityRow(e, {}, 0, '', 0, '', '', '', null, 0, 0)).not.toContain(CANARY);
  });
});

// ===========================================================================
// COMMIT B - NARROW CANDIDATE-UNIVERSE RECONCILIATION
// ===========================================================================
describe('C4-S2 Commit B - narrow candidate-universe reconciliation', () => {
  const HEAD = 'a'.repeat(40), IMPL = 'b'.repeat(40);
  const universe = (rows: any[]): any => ({ ...freezeCandidateUniverse(rows, { runId: '111', attempt: '1', headSha: HEAD, generatedAtUtc: 'T' }), memberRows: rows, model_tool_residual_count: 0 });
  // D-337: GENUINE authority artifacts (real memberHash/memberCount/non-swappable role/universeHash-tied)
  // built by the REAL helper producer and bound to the frozen universe u - NOT a stub tuple. auth() is a
  // spec; cls() freezes u THEN materializes the two artifacts against u.universeHash.
  const authFor = (u: any, m: string[], d: string[], comp = OK): any => ({
    model: buildAuthorityArtifact({ members: m, role: AUTHORITY_ROLE.MODEL, runId: '111', attempt: '1', headSha: HEAD, completeness: comp, universeHash: u.universeHash, generatedAtUtc: 'T' }),
    dataset: buildAuthorityArtifact({ members: d, role: AUTHORITY_ROLE.DATASET, runId: '111', attempt: '1', headSha: HEAD, completeness: comp, universeHash: u.universeHash, generatedAtUtc: 'T' }),
  });
  const auth = (m: string[], d: string[], comp = OK): any => ({ m, d, comp });
  const cls = (a: any, rows: any[], census = true): any => { const u = universe(rows); return classifyPhantoms({ universe: u, authorities: authFor(u, a.m, a.d, a.comp), censusRequested: census, implementationSha: IMPL, nowUtc: 'T' }); };
  const row = (id: string, type: string, o: any = {}): any => {
    const tail = id.replace(/^hf-(model|dataset)--/, '');
    const url = o.source_url ?? (type === 'dataset' && o.genuine ? `https://huggingface.co/datasets/${tail.replace(/--/g, '/')}` : `https://huggingface.co/${tail.replace(/--/g, '/')}`);
    const set = 'source_entity_type' in o ? o.source_entity_type : (o.genuine ? type : undefined);
    return { id, type, umid: o.umid, source_url: url, source_entity_type: set, private: o.private };
  };
  const P = ['hf-dataset--acme--widget', 'hf-model--acme--widget'];

  it('[M6] a model-only phantom dataset is the sole deletion basis (census + complete universe)', () => {
    const res = cls(auth(['hf-model--acme--widget'], []), [row(P[0], 'dataset', { umid: 'umid:d' }), row(P[1], 'model')]);
    expect(res.publishable).toBe(true); expect(res.authority_complete).toBe(true);
    expect(res.removals.map((r: any) => r.removed_canonical_id)).toEqual(['hf-dataset--acme--widget']);
    expect(res.ledger[0]).toMatchObject({ evidence_class: EC.PROVEN_MODEL_ONLY_PHANTOM_DATASET, false_type: 'dataset', surviving_valid_typed_id: 'hf-model--acme--widget', run_id: '111', attempt: '1', implementation_sha: IMPL, removed_umid: 'umid:d' });
    expect(res.ledger[0].universe_hash).toBe(res.universe.universeHash);
    expect(res.reports.count_contract).toMatchObject({ removed_count: 1, ledger_member_count: 1, stale_record_removed: 0, unclassified_conflict_count: 0, valid_id_changed_count: 0, valid_umid_changed_count: 0 });
  });
  it('[M6b] symmetric: a dataset-only phantom model is deletable', () => {
    const res = cls(auth([], ['hf-dataset--acme--corpus']), [row('hf-model--acme--corpus', 'model', { source_url: 'https://huggingface.co/datasets/acme/corpus' }), row('hf-dataset--acme--corpus', 'dataset', { genuine: true })]);
    expect(res.removals.map((r: any) => r.removed_canonical_id)).toEqual(['hf-model--acme--corpus']);
    expect(res.ledger[0].evidence_class).toBe(EC.PROVEN_DATASET_ONLY_PHANTOM_MODEL);
  });
  it('[M7] umid-stability audit DETECTS a retained-umid drift', () => {
    const res = cls(auth(['hf-model--acme--widget'], ['hf-dataset--acme--widget']), [row(P[1], 'model', { umid: 'WRONG-UMID' }), row(P[0], 'dataset', { genuine: true })]);
    expect(res.reports.id_umid_stability.valid_umid_changed).toBe(1);
  });
  it('[M8] on a COMPLETE universe, an UNCLASSIFIED_CONFLICT forces ZERO_PUBLICATION', () => {
    // P[0]+P[1] collide (candidate universe non-empty, owner=acme) so the acme model authority is in-universe.
    const res = cls(auth(['hf-model--acme--widget'], []), [row(P[0], 'dataset', { source_url: 'https://huggingface.co/acme/widget', source_entity_type: 'dataset' }), row(P[1], 'model')]);
    expect(res.authority_complete).toBe(true);
    expect(res.reports.classifications.find((c: any) => c.id === P[0]).evidence_class).toBe(EC.UNCLASSIFIED_CONFLICT);
    expect(res.publishable).toBe(false); expect(res.removals).toHaveLength(0);
    expect(verifyPreFusionGate({ manifest: res, expected: { headSha: HEAD, runId: '111' } }).ok).toBe(false);
  });
  it('[M9] three-way: not-requested => dormant; requested-but-incomplete => ZERO_PUBLICATION', () => {
    const rows = [row(P[0], 'dataset'), row(P[1], 'model')];
    const dormant = cls(auth(['hf-model--acme--widget'], []), rows, false);
    expect(dormant.publishable).toBe(true); expect(dormant.removals).toHaveLength(0);
    const incomplete = cls(auth(['hf-model--acme--widget'], [], 'INCOMPLETE'), rows, true);
    expect(incomplete.authority_complete).toBe(false); expect(incomplete.publishable).toBe(false); expect(incomplete.removals).toHaveLength(0);
  });
  it('[M10] deletion needs POSITIVE opposite-authority membership, never mere absence', () => {
    const res = cls(auth([], []), [row('hf-dataset--ghost--x', 'dataset', { source_url: 'https://huggingface.co/other--z' })]);
    expect(res.removals).toHaveLength(0);
    expect(res.reports.classifications[0].evidence_class).toBe(EC.CURRENT_SOURCE_ABSENT_STALE_RECORD);
  });
  it('[M11] stale + genuine duals + private retained (stale_record_removed=0)', () => {
    const res = cls(auth(['hf-model--acme--widget', 'hf-model--acme--dual'], ['hf-dataset--acme--dual']), [
      row('hf-dataset--old--stale', 'dataset', { genuine: true }), row(P[0], 'dataset'), row(P[1], 'model'),
      row('hf-model--acme--dual', 'model'), row('hf-dataset--acme--dual', 'dataset', { genuine: true }), row('hf-dataset--acme--gated', 'dataset', { private: true })]);
    expect(res.removals.map((r: any) => r.removed_canonical_id)).toEqual(['hf-dataset--acme--widget']);
    expect(res.reports.count_contract.stale_record_removed).toBe(0);
    expect(res.reports.classifications.find((c: any) => c.id === 'hf-dataset--acme--dual').evidence_class).toBe(EC.GENUINE_DUAL);
    expect(res.reports.classifications.find((c: any) => c.id === 'hf-dataset--acme--gated').evidence_class).toBe(EC.PRIVATE_AUTH_GATED);
  });
  it('[gate] PRE (empty=>proceed; removals+cross-head/attempt=>ZERO_PUB) + POST (residual)', () => {
    const complete = cls(auth(['hf-model--acme--widget'], []), [row(P[0], 'dataset', { umid: 'umid:d' }), row(P[1], 'model')]);
    expect(verifyPreFusionGate({ manifest: complete, expected: { headSha: HEAD, runId: '111' } }).ok).toBe(true);
    expect(verifyPreFusionGate({ manifest: complete, expected: { headSha: 'dead', runId: '111' } }).ok).toBe(false);
    expect(verifyPreFusionGate({ manifest: complete, expected: { headSha: HEAD, runId: '999' } }).ok).toBe(false);
    const dormant = cls(auth(['hf-model--acme--widget'], []), [row(P[0], 'dataset'), row(P[1], 'model')], false);
    expect(verifyPreFusionGate({ manifest: dormant, expected: { headSha: 'dead', runId: '999' } }).ok).toBe(true);
    expect(verifyPostPackGate({ manifest: complete, packedIds: ['hf-model--acme--widget'] }).ok).toBe(true);
    expect(verifyPostPackGate({ manifest: complete, packedIds: ['hf-model--acme--widget', 'hf-dataset--acme--widget'] }).ok).toBe(false);
  });
  it('[BL4] run/attempt anti-replay: same-run DIFFERENT-attempt AND same-head FOREIGN-run => ZERO_PUBLICATION', () => {
    const complete = cls(auth(['hf-model--acme--widget'], []), [row(P[0], 'dataset', { umid: 'umid:d' }), row(P[1], 'model')]);
    expect(complete.removals.length).toBe(1);
    expect(verifyPreFusionGate({ manifest: complete, expected: { headSha: HEAD, runId: '111', attempt: '1' } }).ok).toBe(true);
    expect(verifyPreFusionGate({ manifest: complete, expected: { headSha: HEAD, runId: '111', attempt: '2' } }).ok).toBe(false); // stale-attempt replay
    expect(verifyPreFusionGate({ manifest: complete, expected: { headSha: HEAD, runId: '999', attempt: '1' } }).ok).toBe(false); // foreign run, same head
  });
});

// D-337 Blocker 1/2: an authority artifact becomes a deletion basis ONLY if GENUINE - the
// self-reported hash is RECOMPUTED, memberCount matches, sourceRole is the correct non-swappable
// role, and the tuple is tied to THIS frozen universe. A tampered/forged authority => NOT complete.
describe('C4-S2 Commit B - authority-artifact validation (D-337 Blocker 1/2)', () => {
  const HEAD = 'a'.repeat(40);
  const rows = [
    { id: 'hf-dataset--acme--widget', type: 'dataset', umid: 'umid:d', source_url: 'https://huggingface.co/acme/widget', source_entity_type: undefined },
    { id: 'hf-model--acme--widget', type: 'model', source_url: 'https://huggingface.co/acme/widget', source_entity_type: 'model' },
  ];
  const uni = (): any => ({ ...freezeCandidateUniverse(rows, { runId: '111', attempt: '1', headSha: HEAD, generatedAtUtc: 'T' }), memberRows: rows, model_tool_residual_count: 0 });
  const good = (): any => { const u = uni(); return {
    model: buildAuthorityArtifact({ members: ['hf-model--acme--widget'], role: AUTHORITY_ROLE.MODEL, runId: '111', attempt: '1', headSha: HEAD, completeness: OK, universeHash: u.universeHash, generatedAtUtc: 'T' }),
    dataset: buildAuthorityArtifact({ members: [], role: AUTHORITY_ROLE.DATASET, runId: '111', attempt: '1', headSha: HEAD, completeness: OK, universeHash: u.universeHash, generatedAtUtc: 'T' }) }; };
  const complete = (a: any) => classifyPhantoms({ universe: uni(), authorities: a, censusRequested: true, implementationSha: 'IMPL', nowUtc: 'T' }).authority_complete;
  it('[BL1-1] tampered members (self-reported hash no longer recomputes) => NOT complete', () => {
    const a = good(); expect(complete(a)).toBe(true);
    // REPLACE (same count + same owner) so ONLY the hash-recompute check can catch it.
    a.model.members = ['hf-model--acme--other']; expect(complete(a)).toBe(false);
  });
  it('[BL1-2] memberCount mismatch => NOT complete', () => { const a = good(); a.model.tuple.memberCount = 99; expect(complete(a)).toBe(false); });
  it('[BL1-3] wrong OR swapped sourceRole => NOT complete', () => {
    const wrong = good(); wrong.model.tuple.sourceRole = 'not-a-role'; expect(complete(wrong)).toBe(false);
    const swap = good(); const m = swap.model; swap.model = swap.dataset; swap.dataset = m; expect(complete(swap)).toBe(false);
  });
  it('[BL2-4] authority universeHash != frozen universe hash (model or dataset) => NOT complete', () => { const a = good(); a.model.tuple.universeHash = 'deadbeef'; expect(complete(a)).toBe(false); const b = good(); b.dataset.tuple.universeHash = 'deadbeef'; expect(complete(b)).toBe(false); });
  it('[BL1-5] an authority member whose owner is OUTSIDE the frozen owner set => NOT complete (owner-subset guard)', () => {
    const a = good(); expect(complete(a)).toBe(true);
    // forge an OTHERWISE-genuine authority (hash + count recomputed) carrying a foreign-owner member.
    a.model = buildAuthorityArtifact({ members: ['hf-model--acme--widget', 'hf-model--foreign--x'], role: AUTHORITY_ROLE.MODEL, runId: '111', attempt: '1', headSha: HEAD, completeness: OK, universeHash: uni().universeHash, generatedAtUtc: 'T' });
    expect(complete(a)).toBe(false); // 'foreign' is not in frozen.owners (['acme']) => rejected
  });
  it('[BL1-6] a TAMPERED (expanded) frozen owners set fails verifyUniverseHash (owners hash-tied to members)', () => { const u = uni(); expect(verifyUniverseHash(u)).toBe(true); expect(verifyUniverseHash({ ...u, owners: [...u.owners, 'foreign'] })).toBe(false); });
});

// ===========================================================================
// COMMIT B - WORKFLOW-CONTRACT
// ===========================================================================
describe('C4-S2 Commit B - workflow-contract', () => {
  const rd = (p: string) => readFileSync(resolve(REPO, p), 'utf8');
  const harvest = rd('.github/workflows/factory-harvest.yml'), upload = rd('.github/workflows/factory-upload.yml');
  it('harvest freezes + census-on-request + head-sha manifest; upload runs both gates + anti-replay binding', () => {
    expect(harvest).toContain('hf-phantom-reconciler.js freeze');
    expect(harvest).toContain('harvest-single.js c4s2-census');
    expect(harvest).toContain('state/c4-stage2/${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${GITHUB_SHA}/exclusion-manifest.json');
    expect(harvest).not.toContain('c4-stage2/latest');
    expect(upload).toContain('hf-phantom-reconciler.js verify-pre');
    expect(upload).toContain('hf-phantom-reconciler.js verify-post');
    expect(upload).toContain('C4S2_EXPECT_HEAD');
    expect(upload).toContain('C4S2_EXPECT_RUN_ID');
  });
});

// D-338 Blocker 1 (fail-CLOSED cascade tuple): a missing/unreadable/foreign/malformed cascade tuple is a
// BROKEN cascade => ZERO_PUBLICATION. The OLD `!t => ok:true, tuple:null` fail-open (and the census-skip guard
// `exit 0`) are removed. Dormant is a successfully-restored+validated manifest with censusRequested=false, NOT
// tuple absence. BEHAVIORAL via the pure resolveCascadeTuple + censusSkipGuardVerdict (never YAML string-grep).
describe('C4-S2 cascade tuple + census-skip guard fail-closed (D-337 Bl4 / D-338 Bl1)', () => {
  const K = (up: string) => cascadeTupleKey(up);
  it('[BL4-XCAS] concurrent cascade B cannot redirect A; a MISSING tuple now FAILS CLOSED (D-338, was dormant no-op)', () => {
    const store: any = { [K('aggA')]: { runId: 'rA', attempt: '1', headSha: 'H' }, [K('aggB')]: { runId: 'rB', attempt: '1', headSha: 'H' }, 'state/c4-stage2/H/producer-tuple.json': { runId: 'rB', attempt: '1', headSha: 'H' } };
    expect(resolveCascadeTuple({ store, upstreamRunId: 'aggA', headSha: 'H' }).manifestKey).toBe('rA-1-H'); // UNAFFECTED by B's clobber
    expect(resolveCascadeTuple({ store, upstreamRunId: 'aggB', headSha: 'H' }).tuple.runId).toBe('rB');      // B resolves its own
    const missing = resolveCascadeTuple({ store: {}, upstreamRunId: 'aggA', headSha: 'H' });                 // D-338: was ok:true tuple:null
    expect(missing.ok).toBe(false); expect(missing.terminal).toBe(CMISSING);
  });
  // Founder rows: missing (absent/R2-restore-error) / foreign-head / malformed tuple on a fused-cache hit =>
  // ZERO_PUBLICATION; census + cache-skip => FORBIDDEN; census + fresh => allowed. The dormant cache-hit PASS +
  // the D-339/D-340 dormant-manifest validation live in the census file (production-authentic classifyPhantoms manifest).
  it.each([
    ['missing tuple (absent / R2 restore-error) + cache hit => ZP', 'missing', true, true, CMISSING],
    ['foreign-head tuple + cache hit => ZP', 'foreign', true, true, CFOREIGN],
    ['malformed tuple (missing run/attempt) + cache hit => ZP', 'malformed', true, true, CFOREIGN],
    ['valid tuple + census + cache hit => ZP (PRE/POST gates would skip)', 'valid', true, true, CENSUS_SKIP],
    ['valid tuple + census + fresh (no skip) => allowed', 'valid', true, false, null],
  ])('[BL1-D338] %s', (_l, kind, census, skip, terminal) => {
    const store: any = kind === 'foreign' ? { [K('aggA')]: { runId: 'rA', attempt: '1', headSha: 'OTHER' } }
      : kind === 'malformed' ? { [K('aggA')]: { headSha: 'H' } }
      : kind === 'valid' ? { [K('aggA')]: { runId: 'rA', attempt: '1', headSha: 'H' } } : {};
    const resolve = resolveCascadeTuple({ store, upstreamRunId: 'aggA', headSha: 'H' });
    const v = censusSkipGuardVerdict({ resolve, manifest: { censusRequested: census as boolean }, skipCompute: skip as boolean });
    if (terminal) { expect(v.ok).toBeUndefined(); expect(v.terminal).toBe(terminal); }
    else { expect(v.ok).toBe(true); expect(v.dormant).toBe(!census); }
  });
});
