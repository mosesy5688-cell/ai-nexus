/**
 * SRS-1 C4 Stage-2 (D-335/336/339/340): CANDIDATE-UNIVERSE attempt-bound census (Tier-1, HERMETIC). M13-M21 + freeze/hash/drift + injected-fetch pagination + a REAL production-path + the D-339/D-340 dormant-manifest cache-hit validator. Deleting THIS file removes the M13-M21 mutation guards.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { HuggingFaceAdapter } from '../../scripts/ingestion/adapters/huggingface-adapter.js';
import { DatasetsAdapter } from '../../scripts/ingestion/adapters/datasets-adapter.js';
import { classifyPhantoms, verifyPreFusionGate, verifyPostPackGate, assertAuthoritiesComplete, reconcilerRow, exclusionIdSet, ZERO_PUBLICATION_TERMINAL as ZP, EVIDENCE_CLASS as EC } from '../../scripts/factory/lib/hf-phantom-reconciler.js';
import { freezeCandidateUniverse, verifyUniverseHash, detectDrift, isCandidateScopedComplete, buildAuthorityArtifact, AUTHORITY_ROLE, memberHash, resolveHarvestSelection, assertHarvestAttemptEligible, resolveCascadeTuple, cascadeTupleKey, censusSkipGuardVerdict, CANDIDATE_UNIVERSE_DRIFT as DRIFT, HARVEST_SELECTION_INCOMPLETE as HSI, HARVEST_ATTEMPT_INELIGIBLE as HAI, CENSUS_SKIP_FORBIDDEN as CENSUS_SKIP, DORMANT_MANIFEST_INVALID as INVALID, COMPLETE_FOR_C4_STAGE2_CANDIDATE_UNIVERSE as OK } from '../../scripts/factory/lib/c4s2-candidate-universe.js';

const CC0 = { removed_count: 0, ledger_member_count: 0, stale_record_removed: 0, unclassified_conflict_count: 0, valid_id_changed_count: 0, valid_umid_changed_count: 0 };
const r429 = (retryAfter: string): any => ({ status: 429, ok: false, headers: { get: (k: string) => k.toLowerCase() === 'retry-after' ? retryAfter : null }, json: async () => [] });
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const resp = (body: any, link?: string): any => ({ status: 200, ok: true, headers: { get: (k: string) => k.toLowerCase() === 'link' ? (link || null) : null }, json: async () => body });
const errResp = (status: number): any => ({ status, ok: false, headers: { get: () => null }, json: async () => [] });
// exhausting fake: emits `pages` (arrays of {id}); each but the last carries a rel="next" cursor.
const exhaustFake = (fam: string, pages: any[][]) => { let i = 0; return async (_url: string) => { const p = pages[i]; const next = i < pages.length - 1 ? `<https://huggingface.co/api/${fam}?author=acme&cursor=C${i + 1}>; rel="next"` : undefined; i++; return resp(p, next); }; };

describe('C4-S2 candidate-universe census (M13-M21 + production-path)', () => {
  const hf = new HuggingFaceAdapter(), ds = new DatasetsAdapter();
  it('[M13] census requested but an owner not exhausted (mid-run 5xx) => authority INCOMPLETE', async () => {
    const fake = async (url: string) => url.includes('cursor') ? errResp(500) : resp([{ id: 'acme/m1' }], '<https://huggingface.co/api/models?author=acme&cursor=C1>; rel="next"');
    const r = await hf.fetchCensusMembership({ authors: ['acme'], deps: { fetch: fake } });
    expect(r.completeness).not.toBe(OK); expect(r.allExhausted).toBe(false); expect(r.perOwner.acme.exhausted).toBe(false);
  });
  it('[M14] the census request NEVER forges completeness from the env (only exhaustion sets it)', async () => {
    let n = 0; const fake = async () => resp([{ id: 'acme/m' + (n++) }], `<https://huggingface.co/api/models?author=acme&cursor=C${n}>; rel="next"`); // always a next-link -> never exhausts
    const r = await hf.fetchCensusMembership({ authors: ['acme'], deps: { fetch: fake }, maxPagesPerOwner: 3 });
    expect(r.completeness).not.toBe(OK); expect(r.perOwner.acme.terminatedBy).toBe('page-guard');
    const harvest = readFileSync(resolve(REPO, '.github/workflows/factory-harvest.yml'), 'utf8');
    expect(harvest).not.toContain("C4S2_AUTHORITY_CENSUS==='true'?'complete'"); // completeness NOT env-forged
  });
  it('[M15] model+dataset authorities same head but different runId/attempt => NOT complete', () => {
    // GENUINE artifacts (empty members => memberHash("") matches) tied to universe 'U'.
    const art = (role: string, over: any = {}): any => { const members: string[] = []; return { members, tuple: { runId: '1', attempt: '1', headSha: 'H', sourceRole: role, authoritySetHash: memberHash(members), completeness: OK, memberCount: 0, universeHash: 'U', generatedAtUtc: 'T', ...over } }; };
    const opts = { frozenUniverseHash: 'U', frozenOwners: [] };
    expect(assertAuthoritiesComplete({ model: art(AUTHORITY_ROLE.MODEL), dataset: art(AUTHORITY_ROLE.DATASET) }, opts).ok).toBe(true);
    expect(assertAuthoritiesComplete({ model: art(AUTHORITY_ROLE.MODEL), dataset: art(AUTHORITY_ROLE.DATASET, { runId: '9' }) }, opts).ok).toBe(false);
    expect(assertAuthoritiesComplete({ model: art(AUTHORITY_ROLE.MODEL), dataset: art(AUTHORITY_ROLE.DATASET, { attempt: '9' }) }, opts).ok).toBe(false);
  });
  it('[M16] a transformers-no-pipeline HF model mints hf-model-- identity (NOT hf-tool--)', () => {
    const raw: any = { modelId: 'acme/widget', id: 'acme/widget', readme: '', tags: [], cardData: {}, config: {}, pipeline_tag: '', library_name: 'transformers', siblings: [] };
    const e = hf.normalize(raw);
    expect(e.type).toBe('model'); expect(e.source_entity_type).toBe('model'); expect(e.id.startsWith('hf-tool--')).toBe(false); expect(e.id).toBe('hf-model--acme--widget');
  });
  // M17/M18/PAG7/PAG8/FIX2(ds): an owner listing that cannot be exhausted (mid error / cursor loop / author-jump / owner-mismatch / persistent 429) NEVER reaches completeness=OK; the exact terminatedBy is surfaced (fail-closed).
  it.each([
    ['[M17] model MIDDLE-page http error => http-503', 'hf', () => { let i = 0; return async () => { i++; if (i === 2) return errResp(503); return resp([{ id: 'acme/m' + i }], `<https://huggingface.co/api/models?author=acme&cursor=C${i}>; rel="next"`); }; }, {}, 'http-503'],
    ['[M18] dataset cursor forms a LOOP => cursor-loop', 'ds', () => async () => resp([{ id: 'acme/d1' }], '<https://huggingface.co/api/datasets?author=acme&limit=1000>; rel="next"'), { maxPagesPerOwner: 50 }, 'cursor-loop'],
    ['[PAG7] Link cursor CHANGES the author => author-jump', 'hf', () => async (url: string) => url.includes('author=evil') ? resp([{ id: 'evil/x' }]) : resp([{ id: 'acme/m1' }], '<https://huggingface.co/api/models?author=evil&cursor=C1>; rel="next"'), {}, 'author-jump'],
    ['[PAG8] returned repo NOT owned by requester => owner-mismatch', 'ds', () => async () => resp([{ id: 'acme/d1' }, { id: 'someoneelse/y' }]), {}, 'owner-mismatch'],
    ['[FIX2] datasets adapter persistent 429 => 429-budget (not cursor-loop)', 'ds', () => async () => r429('0'), { max429Retries: 2 }, '429-budget'],
  ])('%s => INCOMPLETE', async (_l, kind, factory, opts, tb) => {
    const r = await (kind === 'ds' ? ds : hf).fetchCensusMembership({ authors: ['acme'], deps: { fetch: (factory as any)(), delay: async () => {} }, ...(opts as any) });
    expect(r.completeness).not.toBe(OK); expect(r.perOwner.acme.terminatedBy).toBe(tb);
  });
  it('[M19] a post-freeze OUT-OF-UNIVERSE HF collision at final scan => DRIFT => ZERO_PUBLICATION', () => {
    const frozen = freezeCandidateUniverse([{ id: 'hf-model--acme--widget', source_entity_type: 'model' }, { id: 'hf-dataset--acme--widget', source_entity_type: undefined }], { runId: '1', attempt: '1', headSha: 'H' });
    const drift = detectDrift(frozen, ['hf-model--new--z', 'hf-dataset--new--z']); // an unrelated NEW collision not in the frozen universe
    expect(drift.drift).toBe(true); expect(drift.outOfUniverse).toContain('hf-model--new--z');
    const manifest: any = { publishable: true, censusRequested: true, ledger: [], reports: { count_contract: { ...CC0 } }, universe: frozen };
    expect(verifyPostPackGate({ manifest, packedIds: ['hf-model--new--z', 'hf-dataset--new--z'] }).ok).toBe(false);
    expect(verifyPostPackGate({ manifest, packedIds: ['hf-model--acme--widget'] }).ok).toBe(true);
  });
  it('[M20] the AUTHORITY-TUPLE universeHash is enforced (model==dataset==frozen); a mutated one => NOT complete', () => {
    const rows = [{ id: 'hf-model--acme--widget', type: 'model', source_url: 'https://huggingface.co/acme/widget', source_entity_type: 'model' }, { id: 'hf-dataset--acme--widget', type: 'dataset', source_url: 'https://huggingface.co/acme/widget', source_entity_type: undefined }].map(reconcilerRow);
    const frozen = freezeCandidateUniverse(rows, { runId: '1', attempt: '1', headSha: 'H', generatedAtUtc: 'T' });
    const uni = { ...frozen, memberRows: rows, model_tool_residual_count: 0 };
    const build = (uh: string): any => ({
      model: buildAuthorityArtifact({ members: ['hf-model--acme--widget'], role: AUTHORITY_ROLE.MODEL, runId: '1', attempt: '1', headSha: 'H', completeness: OK, universeHash: uh, generatedAtUtc: 'T' }),
      dataset: buildAuthorityArtifact({ members: [], role: AUTHORITY_ROLE.DATASET, runId: '1', attempt: '1', headSha: 'H', completeness: OK, universeHash: uh, generatedAtUtc: 'T' }),
    });
    const complete = (a: any) => classifyPhantoms({ universe: uni, authorities: a, censusRequested: true, implementationSha: 'IMPL', nowUtc: 'T' }).authority_complete;
    expect(complete(build(frozen.universeHash))).toBe(true);                       // genuine: both tuples carry the frozen universeHash
    const a = build(frozen.universeHash); a.model.tuple.universeHash = 'model-x'; a.dataset.tuple.universeHash = 'dataset-x';
    expect(complete(a)).toBe(false);                                               // model != dataset != frozen => enforced
    expect(complete(build('deadbeef'))).toBe(false);                              // both agree but != frozen => enforced
    expect(verifyUniverseHash({ ...frozen, members: [...frozen.members, 'hf-model--evil--x'] })).toBe(false); // (prior M20 frozen-member tamper coverage retained)
  });
  it('[M21] candidate-scoped completeness ONLY; a GLOBAL-corpus label is NEVER accepted', () => {
    expect(isCandidateScopedComplete(OK)).toBe(true);
    expect(isCandidateScopedComplete('COMPLETE_GLOBAL_HUGGING_FACE_CORPUS')).toBe(false);
    for (const p of ['scripts/factory/lib/c4s2-candidate-universe.js', 'scripts/factory/lib/hf-phantom-reconciler.js', 'scripts/ingestion/adapters/huggingface-adapter.js', 'scripts/ingestion/adapters/datasets-adapter.js', '.github/workflows/factory-harvest.yml']) {
      expect(readFileSync(resolve(REPO, p), 'utf8')).not.toContain('COMPLETE_GLOBAL');
    }
    expect(OK).toBe('COMPLETE_FOR_C4_STAGE2_CANDIDATE_UNIVERSE');
  });
  it('[production-path] freeze -> REAL adapter pagination -> reconcilerRow -> sha256 authority -> classify -> gate -> master-fusion set-difference', async () => {
    const rows = [ // registry entities -> reconcilerRow projection (the SAME slim:false load master-fusion feeds the reconciler)
      { id: 'hf-dataset--acme--widget', type: 'dataset', umid: 'umid:d', source_url: 'https://huggingface.co/acme/widget', source_entity_type: undefined }, // model-form phantom
      { id: 'hf-model--acme--widget', type: 'model', umid: undefined, source_url: 'https://huggingface.co/acme/widget', source_entity_type: 'model' },
    ].map(reconcilerRow);
    const tuple = { runId: '111', attempt: '1', headSha: 'HEAD', generatedAtUtc: 'T' };
    const frozen = freezeCandidateUniverse(rows, tuple);
    expect(frozen.owners).toEqual(['acme']);
    const model = await hf.fetchCensusMembership({ authors: frozen.owners, deps: { fetch: exhaustFake('models', [[{ id: 'acme/widget' }]]) } });
    const dataset = await ds.fetchCensusMembership({ authors: frozen.owners, deps: { fetch: exhaustFake('datasets', [[]]) } }); // owner has NO genuine dataset
    expect(model.completeness).toBe(OK); expect(dataset.completeness).toBe(OK);
    // REAL authority-artifact PRODUCER -> serialize to on-disk JSON -> restore the way the workflows do (D-337 Bl3).
    const produce = (role: string, res: any) => buildAuthorityArtifact({ members: res.members, role, runId: '111', attempt: '1', headSha: 'HEAD', completeness: res.completeness, universeHash: frozen.universeHash, generatedAtUtc: 'T' });
    const onDisk = JSON.stringify({ model: produce(AUTHORITY_ROLE.MODEL, model), dataset: produce(AUTHORITY_ROLE.DATASET, dataset) });
    const authorities = JSON.parse(onDisk); // restored exactly as the workflows restore it
    const universe = { ...frozen, memberRows: rows, model_tool_residual_count: 0 };
    const manifest = classifyPhantoms({ universe, authorities, censusRequested: true, implementationSha: 'IMPL', nowUtc: 'T' }); // deletion flows from the RESTORED artifact
    expect(manifest.publishable).toBe(true); expect(manifest.authority_complete).toBe(true);
    expect(manifest.removals.map((r: any) => r.removed_canonical_id)).toEqual(['hf-dataset--acme--widget']);
    expect(manifest.removals[0].source_authority_hashes.model).toBe(authorities.model.tuple.authoritySetHash);
    expect(verifyPreFusionGate({ manifest, expected: { headSha: 'HEAD', runId: '111', attempt: '1' } }).ok).toBe(true);
    expect(verifyPostPackGate({ manifest, packedIds: ['hf-model--acme--widget'] }).ok).toBe(true);
    const allValidIds = new Set(['hf-model--acme--widget', 'hf-dataset--acme--widget', 'hf-model--other--keep']); // master-fusion exclusionIdSet loop
    let removed = 0; for (const id of exclusionIdSet(manifest)) if (allValidIds.delete(id)) removed++;
    expect(removed).toBe(1);
    expect(allValidIds.has('hf-dataset--acme--widget')).toBe(false); // phantom EXCLUDED from the fused valid-id set
    expect(allValidIds.has('hf-model--acme--widget')).toBe(true);    // real model SURVIVES
    expect(allValidIds.has('hf-model--other--keep')).toBe(true);     // unrelated untouched
  });
  it('[FIX2] a RECOVERABLE 429 retries the SAME url (inner loop, not the cursor-loop guard) => COMPLETE', async () => {
    let c = 0; const fake = async () => { c++; return c === 1 ? r429('0') : resp([{ id: 'acme/m1' }]); }; // 1st 429, retry of same url succeeds+exhausts
    const r = await hf.fetchCensusMembership({ authors: ['acme'], deps: { fetch: fake, delay: async () => {} } });
    expect(r.completeness).toBe(OK); expect(r.metrics.rateLimited).toBe(1); expect(r.perOwner.acme.terminatedBy).toBe('link-absent');
  });
  it('[FIX2] a PERSISTENT 429 is reported 429-budget (NOT mis-detected as cursor-loop) => INCOMPLETE', async () => {
    const r = await hf.fetchCensusMembership({ authors: ['acme'], deps: { fetch: async () => r429('0'), delay: async () => {} }, max429Retries: 3 });
    expect(r.completeness).not.toBe(OK); expect(r.perOwner.acme.terminatedBy).toBe('429-budget');
    expect(r.perOwner.acme.terminatedBy).not.toBe('cursor-loop'); expect(r.metrics.rateLimited).toBe(4); // 3 retries + the terminal over-budget attempt
  });
  it('[FIX4] verify-post RE-RUNS the pure universe-hash verification; a tampered manifest.universe => DRIFT => ZERO_PUBLICATION', () => {
    const frozen = freezeCandidateUniverse([{ id: 'hf-model--acme--widget', source_entity_type: 'model' }, { id: 'hf-dataset--acme--widget', source_entity_type: undefined }], { runId: '1', attempt: '1', headSha: 'H' });
    const good: any = { publishable: true, censusRequested: true, ledger: [], reports: { count_contract: { ...CC0 } }, universe: frozen };
    expect(verifyPostPackGate({ manifest: good, packedIds: ['hf-model--acme--widget'] }).ok).toBe(true);
    const tampered = { ...good, universe: { ...frozen, members: [...frozen.members, 'hf-model--evil--x'] } }; // members mutated after freeze => hash no longer matches
    const g = verifyPostPackGate({ manifest: tampered, packedIds: ['hf-model--acme--widget'] });
    expect(g.ok).toBe(false); expect(g.terminal).toBe(DRIFT);
  });
  it('[FIX5] the id/umid stability audit is CENSUS-SCOPED: a dormant survivor with a bad umid does NOT count; a census cycle does', () => {
    const rows = [{ id: 'hf-dataset--acme--widget', type: 'dataset', umid: 'umid:DEFINITELY-WRONG', source_url: 'https://huggingface.co/acme/widget', source_entity_type: undefined }];
    const frozen = freezeCandidateUniverse(rows, { runId: '1', attempt: '1', headSha: 'H' });
    const universe = { ...frozen, memberRows: rows, model_tool_residual_count: 0 };
    const empty = { model: { members: [], tuple: {} }, dataset: { members: [], tuple: {} } }; // SYNTHETIC (count-scoping only; NOT a production dormant artifact)
    const dormant = classifyPhantoms({ universe, authorities: empty, censusRequested: false, nowUtc: 'T' });
    expect(dormant.publishable).toBe(true); expect(dormant.reports.count_contract.valid_umid_changed_count).toBe(0); // audit skipped when dormant
    // D-340 #7 NEGATIVE: the SYNTHETIC null-binding dormant manifest MUST NOT pass the D-339 validator even on a valid resolve.
    expect(censusSkipGuardVerdict({ resolve: resolveCascadeTuple({ store: { [cascadeTupleKey('u')]: { runId: '1', attempt: '1', headSha: 'H' } }, upstreamRunId: 'u', headSha: 'H' }), manifest: dormant, skipCompute: true }).terminal).toBe(INVALID);
    const census = classifyPhantoms({ universe, authorities: empty, censusRequested: true, nowUtc: 'T' });
    expect(census.reports.count_contract.valid_umid_changed_count).toBe(1); // survivor's bad umid IS audited under census
  });
  it('[FIX5] a DORMANT cycle publishes despite count/drift; a CENSUS count-contract drift => ZERO_PUBLICATION (no false halt of normal cron)', () => {
    const frozen = freezeCandidateUniverse([{ id: 'hf-model--acme--widget', source_entity_type: 'model' }, { id: 'hf-dataset--acme--widget', source_entity_type: undefined }], { runId: '1', attempt: '1', headSha: 'H' });
    const dormant: any = { publishable: true, ledger: [], reports: { count_contract: { removed_count: 5, ledger_member_count: 5, stale_record_removed: 2, unclassified_conflict_count: 1, valid_id_changed_count: 3, valid_umid_changed_count: 4 } }, universe: frozen };
    expect(verifyPostPackGate({ manifest: dormant, packedIds: ['hf-model--new--z', 'hf-dataset--new--z'] }).ok).toBe(true); // dormant: nonzero counts + out-of-universe collision do NOT halt
    const census: any = { publishable: true, censusRequested: true, ledger: [], reports: { count_contract: { ...CC0, valid_umid_changed_count: 1 } }, universe: frozen };
    const g = verifyPostPackGate({ manifest: census, packedIds: ['hf-model--acme--widget'] });
    expect(g.ok).toBe(false); expect(g.terminal).toBe(ZP); // census: a count-contract drift is fail-closed
  });
});

// D-337 Bl4/5 + D-338/D-340 workflow SOURCE contract: cascade-bound selector tuple + IMMUTABLE run/attempt/head
// manifest key + real-harvest-attempt binding + census can NEVER skip PRE/POST on a cache hit + (D-340 #8) harvest
// stamps the dormant authority tuples from the run env + upload passes the FULL manifest (not a reduced boolean).
describe('C4-S2 cascade tuple + immutable key + census-unskippable + D-338/D-340 workflow contract', () => {
  const wf = (p: string) => readFileSync(resolve(REPO, '.github/workflows', p), 'utf8');
  it.each([
    ['factory-process.yml', ['EXPECT_HARVEST_RUN_ID: ${{ needs.check-upstream.outputs.upstream-run-id }}', 'upload-file state/c4-stage2/tuple.json "state/_handoff/c4-stage2/${GITHUB_RUN_ID}/tuple.json"', 'github.event.workflow_run.run_attempt', 'EXPECT_HARVEST_ATTEMPT', 'String(b.attempt)!==String(eA)', 'resolveHarvestSelection', 'assertHarvestAttemptEligible', 'run_attempt:'], ['${GITHUB_SHA}/producer-tuple.json', 'gh run list --workflow factory-harvest.yml']],
    ['factory-aggregate.yml', ['restore-file "state/_handoff/c4-stage2/${UP}/tuple.json"', 'UP: ${{ needs.check-upstream.outputs.process-id }}', 'upload-file state/c4-stage2/tuple.json "state/_handoff/c4-stage2/${AGG_RUN_ID}/tuple.json"', 'state/c4-stage2/${MREF}/exclusion-manifest.json'], ['${GITHUB_SHA}/producer-tuple.json']],
    ['factory-upload.yml', ['restore-file "state/_handoff/c4-stage2/${UP}/tuple.json"', 'resolveCascadeTuple', 'cascadeTupleKey', 'state/c4-stage2/${MREF}/exclusion-manifest.json', 'Census Cannot Skip Gates', 'Census Cannot Skip POST-pack', 'censusSkipGuardVerdict({resolve,manifest,'], ['${GITHUB_SHA}/producer-tuple.json', 'gh run list --workflow factory-harvest.yml', 'censusRequested:census']],
    ['factory-harvest.yml', ['state/c4-stage2/${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${GITHUB_SHA}/exclusion-manifest.json', 'runId:process.env.GITHUB_RUN_ID', 'attempt:process.env.GITHUB_RUN_ATTEMPT', 'headSha:process.env.GITHUB_SHA', 'universeHash:u.universeHash'], []],
  ])('[WF-CONTRACT] %s carries cascade-bound + immutable-key + manifest-in strings; no head-only carrier / reduced boolean', (p, present, absent) => {
    const y = wf(p as string);
    for (const s of present as string[]) expect(y).toContain(s); for (const s of absent as string[]) expect(y).not.toContain(s);
  });
  it('[BL5] both census-skip guards (fuse + pack) fail-closed with the SAME REUSE message, exactly twice', () => {
    expect((wf('factory-upload.yml').match(/census-requested run would REUSE/g) || []).length).toBe(2);
  });
});

// D-338 Blocker 2 (BEHAVIORAL): harvest selection is fail-closed - workflow_run is authoritative (id+attempt); a
// manual dispatch REQUIRES both run_id AND run_attempt (NO gh-run-list latest, NO default attempt 1); the operator-
// named attempt must be the EXACT successful Factory-1/4 Harvest attempt on main at THIS head.
describe('C4-S2 harvest run/attempt selection fail-closed (D-338 Blocker 2)', () => {
  const okRun = { id: '900', run_attempt: '2', name: 'Factory 1/4 - Harvest', head_branch: 'main', conclusion: 'success', head_sha: 'HEAD' };
  it.each([
    ['manual both present => attempt from input, NEVER default-1', 'workflow_dispatch', '900', '2', '', '', true, '2'],
    ['manual missing run_attempt => incomplete', 'workflow_dispatch', '900', '', '', '', false, ''],
    ['manual missing run_id => incomplete', 'workflow_dispatch', '', '2', '', '', false, ''],
    ['automatic workflow_run => attempt from workflow_run', 'workflow_run', '', '', '901', '3', true, '3'],
    ['automatic workflow_run missing attempt => incomplete', 'workflow_run', '', '', '901', '', false, ''],
  ])('[BL2-SEL] %s', (_l, ev, iRid, iAtt, wRid, wAtt, ok, att) => {
    const r = resolveHarvestSelection({ eventName: ev as string, inputRunId: iRid as string, inputRunAttempt: iAtt as string, workflowRunId: wRid as string, workflowRunAttempt: wAtt as string });
    expect(r.ok).toBe(ok);
    if (ok) { expect(r.attempt).toBe(att); expect(r.attempt).not.toBe('1'); } else expect(r.terminal).toBe(HSI);
  });
  it.each([
    ['exact successful attempt => eligible', {}, true],
    ['conclusion != success (failed attempt w/ existing manifest)', { conclusion: 'failure' }, false],
    ['same-run WRONG attempt (cross-attempt replay)', { run_attempt: '1' }, false],
    ['wrong head_sha', { head_sha: 'OTHER' }, false],
    ['wrong workflow name', { name: 'Other' }, false],
    ['null api run (deleted/unreadable)', null, false],
  ])('[BL2-ELIG] %s', (_l, over, ok) => {
    const r = assertHarvestAttemptEligible({ apiRun: over === null ? null : { ...okRun, ...(over as object) }, expectRunId: '900', expectAttempt: '2', expectHeadSha: 'HEAD' });
    if (ok) expect(r.ok).toBe(true); else { expect(r.ok).toBe(false); expect(r.terminal).toBe(HAI); }
  });
});

// D-339 / D-340: the census-skip guard's dormant-manifest validator is the LAST reachable cache-hit fail-open. It
// validates the FULL manifest against D-339 conds 4-10 + the D-340 #5 three-way (binding === universe tuple ===
// resolved cascade tuple). The valid-dormant fixture is PRODUCTION-AUTHENTIC: REAL classifyPhantoms on production-shaped dormant authorities exactly as factory-harvest.yml:817 does. Any hop mismatch => ZERO_PUBLICATION.
describe('C4-S2 D-339/D-340 dormant-manifest validation on cache hit (last fail-open closed)', () => {
  const HH = 'H'.repeat(40);
  const uRows = [{ id: 'hf-model--acme--w', source_entity_type: 'model' }, { id: 'hf-dataset--acme--w', source_entity_type: undefined }];
  const uni = { ...freezeCandidateUniverse(uRows, { runId: '111', attempt: '1', headSha: HH, generatedAtUtc: 'T' }), memberRows: uRows, model_tool_residual_count: 0 };
  // dormant authorities EXACTLY as factory-harvest.yml:817 writes them (populated tuple, empty members, source-name role); classifyPhantoms turns them into the on-disk manifest, JSON round-tripped as Upload restores it.
  const dAuth = (role: string): any => ({ members: [], tuple: { runId: '111', attempt: '1', headSha: HH, sourceRole: role, authoritySetHash: 'dormant', completeness: 'INCOMPLETE', generatedAtUtc: 'T', memberCount: 0, universeHash: uni.universeHash } });
  const DORM = (): any => JSON.parse(JSON.stringify(classifyPhantoms({ universe: uni, authorities: { model: dAuth('huggingface'), dataset: dAuth('academic') }, censusRequested: false, nowUtc: 'T' })));
  const res = (t: any): any => resolveCascadeTuple({ store: { [cascadeTupleKey('u')]: t }, upstreamRunId: 'u', headSha: t.headSha });
  const good = () => res({ runId: '111', attempt: '1', headSha: HH });
  it('[D339-AUTHENTIC] the production dormant manifest binds binding == universe tuple == current tuple; publishable; empty', () => {
    const m = DORM();
    expect([m.censusRequested, m.publishable, m.ledger.length, m.removals.length]).toEqual([false, true, 0, 0]);
    expect([m.binding.runId, m.binding.attempt, m.binding.headSha]).toEqual(['111', '1', HH]);
    expect([m.universe.runId, m.universe.attempt, m.universe.headSha]).toEqual(['111', '1', HH]);
  });
  it.each([
    ['valid dormant (production-authentic) + cache hit => ok/dormant', (m: any) => m, null, true, null, true],
    ['missing censusRequested => INVALID', (m: any) => (delete m.censusRequested, m), null, true, INVALID, null],
    ['censusRequested null => INVALID', (m: any) => (m.censusRequested = null, m), null, true, INVALID, null],
    ['censusRequested "false" string => INVALID', (m: any) => (m.censusRequested = 'false', m), null, true, INVALID, null],
    ['publishable=false => INVALID', (m: any) => (m.publishable = false, m), null, true, INVALID, null],
    ['binding run mismatch => INVALID', (m: any) => (m.binding.runId = '999', m), null, true, INVALID, null],
    ['binding attempt mismatch => INVALID', (m: any) => (m.binding.attempt = '9', m), null, true, INVALID, null],
    ['binding head mismatch => INVALID', (m: any) => (m.binding.headSha = 'Z'.repeat(40), m), null, true, INVALID, null],
    ['invalid universe hash => INVALID', (m: any) => (m.universe.universeHash = 'deadbeef', m), null, true, INVALID, null],
    ['non-empty ledger => INVALID', (m: any) => (m.ledger = [{ removed_canonical_id: 'x' }], m), null, true, INVALID, null],
    ['non-empty removals => INVALID', (m: any) => (m.removals = [{ removed_canonical_id: 'x' }], m), null, true, INVALID, null],
    ['count-contract attests removals => INVALID', (m: any) => (m.reports.count_contract.removed_count = 1, m), null, true, INVALID, null],
    ['valid census + cache hit (skip) => CENSUS_SKIP_FORBIDDEN', (m: any) => (m.censusRequested = true, m), null, true, CENSUS_SKIP, null],
    ['valid census + fresh compute (no skip) => ok/dormant:false', (m: any) => (m.censusRequested = true, m), null, false, null, false],
    ['[3WAY-a] universe tuple != resolved cascade tuple => INVALID', (m: any) => (m.universe.runId = '222', m), null, true, INVALID, null],
    ['[3WAY-b] binding tuple != resolved cascade tuple => INVALID', (m: any) => (m.binding.runId = '222', m), null, true, INVALID, null],
    ['[WIRE] resolve run differs => ZERO_PUBLICATION', (m: any) => m, { runId: '999', attempt: '1', headSha: HH }, true, INVALID, null],
    ['[WIRE] resolve attempt differs => ZERO_PUBLICATION', (m: any) => m, { runId: '111', attempt: '9', headSha: HH }, true, INVALID, null],
    ['[WIRE] resolve head differs => ZERO_PUBLICATION', (m: any) => m, { runId: '111', attempt: '1', headSha: 'Z'.repeat(40) }, true, INVALID, null],
  ])('[D339-BEHAVIOR] %s', (_l, mutate, rt, skip, terminal, dormant) => {
    const v = censusSkipGuardVerdict({ resolve: rt ? res(rt) : good(), manifest: (mutate as any)(DORM()), skipCompute: skip as boolean });
    if (terminal) { expect(v.ok).toBeUndefined(); expect(v.terminal).toBe(terminal); }
    else { expect(v.ok).toBe(true); expect(v.dormant).toBe(dormant); }
  });
});
