/**
 * C4 Stage-2 (D-333/335/336): HF cross-type phantom reconciler. Layer =
 * classification / retention / ledger / counts / publication verdict ONLY. Freeze /
 * hash / owner / drift live in c4s2-candidate-universe.js (called, never duplicated);
 * HF Link-cursor pagination lives in the adapters. NARROW: deletes ONLY the two
 * PROVEN_*_PHANTOM (model<->dataset) classes, and ONLY when census was requested AND
 * the candidate universe is dual-source-exhausted COMPLETE_FOR_C4_STAGE2_CANDIDATE_
 * UNIVERSE AND tuple-verified AND drift-free. Otherwise: dormant (census not
 * requested => publishable) or ZERO_PUBLICATION (requested-but-incomplete/drift).
 * source_entity_type stays INTERNAL; no canonical-ID/UMID algorithm change.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateUMID } from './umid-generator.js';
import { normalizeId, getNodeSource } from '../../utils/id-normalizer.js';
import { freezeCandidateUniverse, verifyUniverseHash, detectDrift, collisionMembersFromIds,
  isCandidateScopedComplete, idTail, CANDIDATE_UNIVERSE_DRIFT, validateAuthorityArtifact, AUTHORITY_ROLE } from './c4s2-candidate-universe.js';

export const ZERO_PUBLICATION_TERMINAL = 'C4_STAGE2_SOURCE_FAMILY_AUTHORITY_INCOMPLETE';
export const EVIDENCE_CLASS = Object.freeze({
  PROVEN_MODEL_ONLY_PHANTOM_DATASET: 'PROVEN_MODEL_ONLY_PHANTOM_DATASET',
  PROVEN_DATASET_ONLY_PHANTOM_MODEL: 'PROVEN_DATASET_ONLY_PHANTOM_MODEL',
  GENUINE_DUAL: 'GENUINE_DUAL', PRIVATE_AUTH_GATED: 'PRIVATE_AUTH_GATED',
  CURRENT_SOURCE_ABSENT_STALE_RECORD: 'CURRENT_SOURCE_ABSENT_STALE_RECORD',
  UNCLASSIFIED_CONFLICT: 'UNCLASSIFIED_CONFLICT', NOT_A_CANDIDATE: 'NOT_A_CANDIDATE',
});
const DELETABLE = new Set([EVIDENCE_CLASS.PROVEN_MODEL_ONLY_PHANTOM_DATASET, EVIDENCE_CLASS.PROVEN_DATASET_ONLY_PHANTOM_MODEL]);
const STALE = new Set([EVIDENCE_CLASS.CURRENT_SOURCE_ABSENT_STALE_RECORD]);
const isHf = id => String(id || '').toLowerCase().startsWith('hf-');
const isDatasetsForm = r => String(r.source_url || '').includes('/datasets/');

export function buildMembership(authority) {
  const s = new Set(); for (const id of (authority && authority.members) || []) s.add(idTail(id)); return s;
}
// Deletion-required completeness = dual-source exhaustion over the frozen candidate
// universe: BOTH authorities GENUINE (D-337 Blocker 1: hash recomputed / memberCount /
// non-swappable role / universeHash-tied / owner-subset via validateAuthorityArtifact) +
// SAME run/attempt/head tuple + tied to the SAME frozen universe.
export function assertAuthoritiesComplete(a, opts = {}) {
  const m = a && a.model, d = a && a.dataset;
  if (!m || !m.tuple || !d || !d.tuple) return { ok: false, reason: 'missing model or dataset authority' };
  const vo = { frozenUniverseHash: opts.frozenUniverseHash, frozenOwners: opts.frozenOwners };
  const vm = validateAuthorityArtifact(m, { role: AUTHORITY_ROLE.MODEL, ...vo });
  if (!vm.ok) return { ok: false, reason: `model authority: ${vm.reason}` };
  const vd = validateAuthorityArtifact(d, { role: AUTHORITY_ROLE.DATASET, ...vo });
  if (!vd.ok) return { ok: false, reason: `dataset authority: ${vd.reason}` };
  // Per-authority validateAuthorityArtifact already ties BOTH universeHash === frozen (=> equal);
  // only run/attempt/head sameness (not frozen-tied per-authority) needs a cross-authority assert.
  if (m.tuple.runId !== d.tuple.runId || m.tuple.attempt !== d.tuple.attempt || m.tuple.headSha !== d.tuple.headSha) return { ok: false, reason: 'authorities not from the same run/attempt/head tuple' };
  return { ok: true, reason: 'complete' };
}

// Reconciler-load projection: exactly the fields the LOCKED predicate needs (CLI loads
// slim:false so source_url + source_entity_type survive; slim projectEntity strips them).
export function reconcilerRow(e) {
  return {
    id: e.id, type: e.type || e.entity_type || 'model', umid: e.umid,
    source_url: e.source_url || '', source_entity_type: e.source_entity_type,
    private: !!(e.private || e.gated || (e.meta_json && e.meta_json.private)),
  };
}

// ONE classifier for both row types. Cross-type phantom requires opposite-only
// membership AND opposite-family provenance (source_url) AND source_entity_type !=
// served type. Provenance/family DISAGREEMENT => UNCLASSIFIED_CONFLICT (fail-closed).
export function classifyRow(r) {
  const C = EVIDENCE_CLASS;
  if (!isHf(r.id) || (r.type !== 'dataset' && r.type !== 'model')) return C.NOT_A_CANDIDATE;
  if (r.private) return C.PRIVATE_AUTH_GATED;
  const isDs = r.type === 'dataset';
  const selfPresent = isDs ? r.inDataset : r.inModel, oppPresent = isDs ? r.inModel : r.inDataset;
  if (selfPresent && oppPresent) return C.GENUINE_DUAL;
  if (oppPresent && !selfPresent) {
    const oppForm = isDs ? !isDatasetsForm(r) : isDatasetsForm(r);
    const notOwnFamily = r.source_entity_type !== r.type;
    if (oppForm && notOwnFamily) return isDs ? C.PROVEN_MODEL_ONLY_PHANTOM_DATASET : C.PROVEN_DATASET_ONLY_PHANTOM_MODEL;
    if (oppForm !== notOwnFamily) return C.UNCLASSIFIED_CONFLICT;
    return C.CURRENT_SOURCE_ABSENT_STALE_RECORD;
  }
  if (selfPresent) return C.NOT_A_CANDIDATE;
  return C.CURRENT_SOURCE_ABSENT_STALE_RECORD;
}

/**
 * Classify the FROZEN candidate universe against the dual-source per-owner authorities.
 * THREE-WAY publishable: (i) census not requested => true (dormant); (ii) requested +
 * complete + tuple/universe-verified => fail-closed on unclassified; (iii) requested +
 * incomplete/tuple-mismatch/universe-invalid => false = ZERO_PUBLICATION.
 */
export function classifyPhantoms({ universe = {}, authorities, censusRequested = false, implementationSha = '', nowUtc } = {}) {
  const generatedAtUtc = nowUtc || new Date().toISOString();
  const binding = bindingOf(authorities);
  const memberRows = universe.memberRows || [];
  const universeOk = verifyUniverseHash(universe) &&
    String(universe.runId) === String(binding.runId) && String(universe.attempt) === String(binding.attempt) && String(universe.headSha) === String(binding.headSha);
  const authority_complete = assertAuthoritiesComplete(authorities, { frozenUniverseHash: universe.universeHash, frozenOwners: universe.owners }).ok && universeOk;
  const canDelete = censusRequested === true && authority_complete;
  const modelM = buildMembership(authorities && authorities.model), datasetM = buildMembership(authorities && authorities.dataset);
  const ledger = [], classifications = []; let dual = 0, gatedC = 0, unclassified = 0;
  const removedIds = new Set();
  for (const r of memberRows) {
    if (!isHf(r.id)) continue;
    r.inModel = modelM.has(idTail(r.id)); r.inDataset = datasetM.has(idTail(r.id));
    const cls = classifyRow(r);
    classifications.push({ id: r.id, type: r.type, evidence_class: cls, in_model: r.inModel, in_dataset: r.inDataset });
    if (cls === EVIDENCE_CLASS.GENUINE_DUAL) dual++;
    else if (cls === EVIDENCE_CLASS.PRIVATE_AUTH_GATED) gatedC++;
    else if (cls === EVIDENCE_CLASS.UNCLASSIFIED_CONFLICT) unclassified++;
    if (DELETABLE.has(cls) && canDelete) { // delete ONLY on census-requested + candidate-scoped-complete authority
      const tail = idTail(r.id);
      const surviving = cls === EVIDENCE_CLASS.PROVEN_MODEL_ONLY_PHANTOM_DATASET ? 'hf-model--' + tail : 'hf-dataset--' + tail;
      ledger.push({ removed_canonical_id: r.id, removed_umid: r.umid || null, false_type: r.type, surviving_valid_typed_id: surviving,
        source_authority_hashes: { model: binding.model.authoritySetHash, dataset: binding.dataset.authoritySetHash },
        evidence_class: cls, reason_code: cls, run_id: binding.runId, attempt: binding.attempt,
        implementation_sha: implementationSha, universe_hash: universe.universeHash || null, observed_utc: generatedAtUtc, generated_utc: generatedAtUtc });
      removedIds.add(r.id);
    }
  }
  // DERIVED stability audit - CENSUS-SCOPED: a dormant cycle publishes regardless of a
  // pre-existing id/umid drift; the fail-closed contract applies only to a census deletion.
  let valid_id_changed = 0, valid_umid_changed = 0;
  if (censusRequested) for (const r of memberRows) {
    if (!isHf(r.id) || removedIds.has(r.id)) continue;
    if (normalizeId(r.id, getNodeSource(r.id, r.type), r.type) !== r.id) valid_id_changed++;
    if (r.umid && r.umid !== generateUMID(r.id)) valid_umid_changed++;
  }
  const stale_record_removed = ledger.filter(l => STALE.has(l.evidence_class)).length;
  const publishable = censusRequested ? (authority_complete ? (unclassified === 0) : false) : true;
  const reports = {
    binding, classifications,
    count_contract: { removed_count: ledger.length, ledger_member_count: ledger.length, stale_record_removed,
      unclassified_conflict_count: unclassified, valid_id_changed_count: valid_id_changed, valid_umid_changed_count: valid_umid_changed,
      genuine_dual_count: dual, private_gated_count: gatedC, model_tool_residual_count: universe.model_tool_residual_count || 0 },
    candidate_universe: { universeHash: universe.universeHash || null, candidateCount: universe.candidateCount ?? memberRows.length,
      uniqueOwnerCount: universe.uniqueOwnerCount ?? 0, completeness: binding.model.completeness, census_requested: censusRequested },
    reconciliation: { phantom_dataset_removed: ledger.filter(l => l.evidence_class === EVIDENCE_CLASS.PROVEN_MODEL_ONLY_PHANTOM_DATASET).length,
      phantom_model_removed: ledger.filter(l => l.evidence_class === EVIDENCE_CLASS.PROVEN_DATASET_ONLY_PHANTOM_MODEL).length, authority_complete },
    id_umid_stability: { valid_id_changed, valid_umid_changed },
  };
  return { publishable, authority_complete, censusRequested, removals: ledger, ledger, binding, generatedAtUtc, reports,
    // FIX 4: carry the FULL frozen scope so verify-post can re-run verifyUniverseHash (tamper guard).
    universe: { version: universe.version, runId: universe.runId, attempt: universe.attempt, headSha: universe.headSha, generatedAtUtc: universe.generatedAtUtc, candidateCount: universe.candidateCount, uniqueOwnerCount: universe.uniqueOwnerCount, memberHash: universe.memberHash, universeHash: universe.universeHash || null, members: universe.members || [], owners: universe.owners || [] },
    reason: publishable ? (authority_complete ? 'complete' : (censusRequested ? 'ZERO_PUBLICATION (never here)' : 'dormant (census not requested)'))
      : (!censusRequested ? 'dormant' : (authority_complete ? 'ZERO_PUBLICATION (unclassified conflict on complete authority)' : 'ZERO_PUBLICATION (census requested but candidate universe incomplete / tuple-mismatch)')) };
}

function bindingOf(a) {
  const m = (a && a.model && a.model.tuple) || {}, d = (a && a.dataset && a.dataset.tuple) || {};
  return { runId: m.runId ?? null, attempt: m.attempt ?? null, headSha: m.headSha ?? null,
    model: { authoritySetHash: m.authoritySetHash ?? null, completeness: m.completeness ?? null, memberCount: m.memberCount ?? null },
    dataset: { authoritySetHash: d.authoritySetHash ?? null, completeness: d.completeness ?? null, memberCount: d.memberCount ?? null } };
}

/** PRE-fusion gate: reject unpublishable/anti-replay; a bound no-op (empty) manifest PROCEEDS. */
export function verifyPreFusionGate({ manifest, expected } = {}) {
  if (!manifest) return { ok: false, terminal: ZERO_PUBLICATION_TERMINAL, reason: 'no exclusion manifest' };
  if (manifest.publishable === false) return { ok: false, terminal: ZERO_PUBLICATION_TERMINAL, reason: manifest.reason || 'not publishable' };
  const led = manifest.ledger || manifest.removals || [], b = manifest.binding || {};
  // Anti-replay run/attempt/head binding is enforced ONLY when the manifest actually
  // carries removals (a deletion). An empty (dormant/no-op) manifest applies zero
  // exclusions and poses no replay risk => it PROCEEDS unconditionally.
  if (led.length > 0) {
    if (manifest.authority_complete !== true) return { ok: false, terminal: ZERO_PUBLICATION_TERMINAL, reason: 'removals on non-complete authority' };
    if (expected) {
      if (expected.headSha && String(b.headSha) !== String(expected.headSha)) return { ok: false, terminal: ZERO_PUBLICATION_TERMINAL, reason: 'manifest head-sha != current head (cross-head replay)' };
      if (expected.runId && String(b.runId) !== String(expected.runId)) return { ok: false, terminal: ZERO_PUBLICATION_TERMINAL, reason: 'manifest run-id mismatch (cross-attempt replay)' };
      if (expected.attempt && String(b.attempt) !== String(expected.attempt)) return { ok: false, terminal: ZERO_PUBLICATION_TERMINAL, reason: 'manifest attempt mismatch' };
    }
  }
  return { ok: true, terminal: null, reason: led.length ? 'complete+bound' : 'no-op (empty exclusion)' };
}

/** POST-pack gate: universe re-verify + no proven phantom survives + count reconciliation + NO drift. */
export function verifyPostPackGate({ manifest, packedIds } = {}) {
  if (!manifest || manifest.publishable === false) return { ok: false, terminal: ZERO_PUBLICATION_TERMINAL, reason: 'no valid manifest' };
  // Dormant (census NOT requested => no deletion applied) publishes normally: nothing to verify.
  if (manifest.censusRequested !== true) return { ok: true, terminal: null, reason: 'dormant (no deletion applied)' };
  // FIX 4: re-run the pure universe-hash verification on the FULL carried scope (tamper guard
  // between classify and verify-post) BEFORE trusting manifest.universe.members for drift.
  if (!verifyUniverseHash(manifest.universe)) return { ok: false, terminal: CANDIDATE_UNIVERSE_DRIFT, reason: 'universe hash re-verify failed (tampered manifest)' };
  const packed = new Set(packedIds || []);
  const led = manifest.ledger || manifest.removals || [];
  const residual = led.filter(l => packed.has(l.removed_canonical_id)).map(l => l.removed_canonical_id);
  if (residual.length) return { ok: false, terminal: ZERO_PUBLICATION_TERMINAL, reason: `proven phantom survived pack: ${residual.slice(0, 5).join(',')}` };
  const drift = detectDrift({ members: (manifest.universe && manifest.universe.members) || [] }, collisionMembersFromIds(packedIds || []));
  if (drift.drift) return { ok: false, terminal: CANDIDATE_UNIVERSE_DRIFT, reason: `out-of-universe HF collision at final scan: ${drift.outOfUniverse.slice(0, 5).join(',')}` };
  const cc = (manifest.reports && manifest.reports.count_contract) || {};
  if (cc.removed_count !== led.length || cc.ledger_member_count !== led.length || cc.stale_record_removed !== 0 ||
      cc.unclassified_conflict_count !== 0 || cc.valid_id_changed_count !== 0 || cc.valid_umid_changed_count !== 0) {
    return { ok: false, terminal: ZERO_PUBLICATION_TERMINAL, reason: 'count-contract drift' };
  }
  return { ok: true, terminal: null, reason: 'no-residual+no-drift+counts-ok' };
}

export function exclusionIdSet(manifest) {
  return new Set(((manifest && (manifest.ledger || manifest.removals)) || []).map(l => l.removed_canonical_id));
}
// CLI (production wiring; never runs on import). IO only - pure logic + helper above.
async function readJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; } }
function writeJson(p, o) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); }
function fatal(msg) { console.error(`[C4-S2] BUILD HALTED (ZERO_PUBLICATION): ${msg}`); process.exit(1); }
async function loadRegistryRows() {
  const { loadRegistryShardsSequentially } = await import('./registry-loader.js');
  const rows = []; await loadRegistryShardsSequentially(async (ents) => { for (const e of ents) rows.push(reconcilerRow(e)); }, { slim: false });
  return rows;
}
async function cliMain(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'freeze') { // load registry -> PURE-helper freeze -> write frozen universe artifact (members + rows + hashes + tuple)
    const [outPath] = rest;
    const rows = await loadRegistryRows();
    const tuple = { runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, headSha: process.env.GITHUB_SHA, generatedAtUtc: new Date().toISOString() };
    const frozen = freezeCandidateUniverse(rows, tuple);
    const memberSet = new Set(frozen.members);
    const memberRows = rows.filter(r => memberSet.has(String(r.id).toLowerCase()));
    const model_tool_residual_count = rows.filter(r => String(r.id).toLowerCase().startsWith('hf-tool--')).length;
    writeJson(outPath, { ...frozen, memberRows, model_tool_residual_count, censusRequested: process.env.C4S2_AUTHORITY_CENSUS === 'true' });
    console.log(`[C4-S2] freeze: candidates=${frozen.candidateCount} owners=${frozen.uniqueOwnerCount} hf_tool_residual=${model_tool_residual_count} universeHash=${frozen.universeHash.slice(0, 12)}`);
  } else if (cmd === 'classify') {
    const [modelAuthPath, datasetAuthPath, universePath, outPath] = rest;
    const universe = await readJson(universePath, {});
    const authorities = { model: await readJson(modelAuthPath, { members: [], tuple: {} }), dataset: await readJson(datasetAuthPath, { members: [], tuple: {} }) };
    const res = classifyPhantoms({ universe, authorities, censusRequested: universe.censusRequested === true, implementationSha: process.env.GITHUB_SHA || '' });
    writeJson(outPath, res);
    console.log(`[C4-S2] classify: census=${res.censusRequested} complete=${res.authority_complete} publishable=${res.publishable} removals=${res.removals.length} unclassified=${res.reports.count_contract.unclassified_conflict_count} residual_tool=${res.reports.count_contract.model_tool_residual_count}`);
  } else if (cmd === 'verify-pre') {
    const manifest = await readJson(rest[0], null);
    const expected = process.env.C4S2_EXPECT_HEAD ? { headSha: process.env.C4S2_EXPECT_HEAD, runId: process.env.C4S2_EXPECT_RUN_ID, attempt: process.env.C4S2_EXPECT_ATTEMPT } : undefined;
    const g = verifyPreFusionGate({ manifest, expected });
    if (!g.ok) fatal(g.reason);
    console.log('[C4-S2] pre-fusion gate PASS: ' + g.reason);
  } else if (cmd === 'verify-post') {
    const [manifestPath, metaDir] = rest;
    const manifest = await readJson(manifestPath, null);
    const Database = (await import('better-sqlite3')).default;
    const packedIds = [];
    for (const f of fs.readdirSync(metaDir).filter(x => /^meta-\d+\.db$/.test(x))) {
      const db = new Database(path.join(metaDir, f), { readonly: true });
      for (const row of db.prepare('SELECT id FROM entities').iterate()) packedIds.push(row.id);
      db.close();
    }
    const g = verifyPostPackGate({ manifest, packedIds });
    if (!g.ok) fatal(g.reason);
    console.log('[C4-S2] post-pack gate PASS');
  } else { fatal(`unknown command: ${cmd}`); }
}
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) cliMain(process.argv.slice(2)).catch(e => fatal(e.message));
