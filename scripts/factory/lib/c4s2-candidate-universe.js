/**
 * C4 Stage-2 (Founder D-2026-0714-335/336): PURE candidate-universe helper. The
 * ONLY home for candidate freeze / deterministic hash / owner extraction / scope
 * tuple binding / frozen-universe drift detection / candidate-scoped completeness-
 * label validation.
 *
 * PURE + DETERMINISTIC. FORBIDDEN here: HF/network access; reading env vars to
 * decide completeness; any R2 / cache / registry-DB / publication-pointer access;
 * performing deletion; deciding phantom classification; writing the removal ledger;
 * implementing adapter pagination; generic registry compaction; a standalone CLI;
 * any public REST/MCP/SDK schema. Inputs are plain records; outputs are plain
 * objects. The ONLY dependency is node:crypto (sha256).
 */
import crypto from 'node:crypto';

export const CANDIDATE_UNIVERSE_VERSION = 'C4_STAGE2_CANDIDATE_UNIVERSE_V1';
export const COMPLETE_FOR_C4_STAGE2_CANDIDATE_UNIVERSE = 'COMPLETE_FOR_C4_STAGE2_CANDIDATE_UNIVERSE';
export const CANDIDATE_UNIVERSE_DRIFT = 'C4_STAGE2_CANDIDATE_UNIVERSE_DRIFT';
// Non-swappable per-family authority roles (D-337 Blocker 1): the model-endpoint census
// authority MUST carry MODEL; the dataset-endpoint census authority MUST carry DATASET.
export const AUTHORITY_ROLE = Object.freeze({ MODEL: 'hf-model-source-authority', DATASET: 'hf-dataset-source-authority' });

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const isHf = id => String(id || '').toLowerCase().startsWith('hf-');
const prefixType = id => { const m = String(id || '').toLowerCase().match(/^hf-(model|dataset)--/); return m ? m[1] : null; };
export function idTail(id) { return String(id || '').toLowerCase().replace(/^hf-[a-z]+--/, ''); }
export function ownerOf(id) { return idTail(id).split('--')[0]; }
export function dedupSort(members) { return Array.from(new Set((members || []).map(x => String(x).toLowerCase()))).sort(); }
export function memberHash(members) { return sha256(dedupSort(members).join('\n')); }
export function extractOwners(members) { return Array.from(new Set(dedupSort(members).map(ownerOf))).sort(); }

/**
 * A record is a CANDIDATE iff it is an HF model/dataset row AND either (a) its
 * normalized owner/name tail collides across the model AND dataset families, or
 * (b) its id-prefix type disagrees with its INTERNAL source_entity_type provenance
 * (i.e. it could enter one of the two PROVEN_*_PHANTOM classes). Deterministic.
 * @param {Array<{id:string, source_entity_type?:string}>} records
 * @returns {string[]} deduped+sorted candidate canonical ids
 */
export function normalizeCandidateMembers(records) {
  const byTail = new Map(); const rows = [];
  for (const r of records || []) {
    const pt = prefixType(r.id); if (!isHf(r.id) || !pt) continue;
    const tail = idTail(r.id);
    let e = byTail.get(tail); if (!e) { e = { model: false, dataset: false }; byTail.set(tail, e); }
    e[pt] = true;
    rows.push({ id: String(r.id).toLowerCase(), pt, tail, set: r.source_entity_type });
  }
  const members = [];
  for (const r of rows) {
    const c = byTail.get(r.tail);
    const collision = c.model && c.dataset;                 // (a) cross-family collision
    const mismatch = r.set != null && r.set !== r.pt;       // (b) provenance/id-type mismatch
    if (collision || mismatch) members.push(r.id);
  }
  return dedupSort(members);
}

/**
 * Freeze a CLOSED candidate universe bound to the CURRENT attempt tuple, with a
 * deterministic member hash and universe hash. After freeze, membership is fixed.
 * @param {Array} records  registry candidate records (id + source_entity_type)
 * @param {{runId?:string,attempt?:string,headSha?:string,generatedAtUtc?:string}} tuple
 */
export function freezeCandidateUniverse(records, tuple = {}) {
  const members = normalizeCandidateMembers(records);
  const owners = extractOwners(members);
  const mHash = memberHash(members);
  const scope = {
    version: CANDIDATE_UNIVERSE_VERSION,
    runId: tuple.runId ?? null, attempt: tuple.attempt ?? null, headSha: tuple.headSha ?? null,
    generatedAtUtc: tuple.generatedAtUtc ?? null,
    candidateCount: members.length, uniqueOwnerCount: owners.length, memberHash: mHash,
  };
  return { ...scope, members, owners, universeHash: sha256(JSON.stringify(scope)) };
}

/** Recompute + verify the frozen universe hash + member hash (tamper / mismatch guard). */
export function verifyUniverseHash(frozen) {
  if (!frozen) return false;
  const scope = {
    version: frozen.version, runId: frozen.runId, attempt: frozen.attempt, headSha: frozen.headSha,
    generatedAtUtc: frozen.generatedAtUtc, candidateCount: frozen.candidateCount,
    uniqueOwnerCount: frozen.uniqueOwnerCount, memberHash: frozen.memberHash,
  };
  // D-337 fold-in: owners is DERIVED from the hash-protected members, so re-derive + assert
  // it matches the carried owners (a tampered/expanded owners set - which the owner-subset
  // deletion guard trusts - is thereby hash-protected too).
  const ownersOk = JSON.stringify(extractOwners(frozen.members || [])) === JSON.stringify(frozen.owners || []);
  return sha256(JSON.stringify(scope)) === frozen.universeHash && memberHash(frozen.members || []) === frozen.memberHash && ownersOk;
}

/**
 * DRIFT: any HF model/dataset collision member observed at the FINAL pre-publication
 * scan that is NOT in the frozen member set => out-of-universe => drift.
 * @param {{members:string[]}} frozen
 * @param {string[]} currentCollisionMembers ids of members in HF model/dataset collisions at scan time
 */
export function detectDrift(frozen, currentCollisionMembers) {
  const frozenSet = new Set((frozen && frozen.members) || []);
  const outOfUniverse = dedupSort((currentCollisionMembers || []).filter(id => !frozenSet.has(String(id).toLowerCase())));
  return { drift: outOfUniverse.length > 0, outOfUniverse };
}

/**
 * Collision members from a flat id list (the packed/published set): every id whose
 * owner/name tail appears as BOTH an hf-model-- and an hf-dataset-- id. Used to feed
 * detectDrift at final scan. Deterministic; no side effects.
 */
export function collisionMembersFromIds(ids) {
  const byTail = new Map();
  for (const id of ids || []) { const pt = prefixType(id); if (!pt) continue; const t = idTail(id); let e = byTail.get(t); if (!e) { e = { model: false, dataset: false }; byTail.set(t, e); } e[pt] = true; }
  const out = [];
  for (const id of ids || []) { const pt = prefixType(id); if (!pt) continue; const c = byTail.get(idTail(id)); if (c.model && c.dataset) out.push(String(id).toLowerCase()); }
  return dedupSort(out);
}

/** Candidate-scoped completeness label ONLY. A global-corpus label is NEVER valid here. */
export function isCandidateScopedComplete(label) { return label === COMPLETE_FOR_C4_STAGE2_CANDIDATE_UNIVERSE; }

/**
 * PURE authority-artifact PRODUCER (D-337 Blocker 3): census members + scope tuple ->
 * the EXACT on-disk authority artifact. authoritySetHash is the SAME deterministic
 * memberHash the validator recomputes (never a divergent ad-hoc hash). harvest-single's
 * c4s2-census calls THIS (producer = pure freeze/hash/tuple work = helper domain), so the
 * deletion decision flows from a genuine serialized/restored artifact, not a hand tuple.
 */
export function buildAuthorityArtifact({ members, role, runId, attempt, headSha, completeness, universeHash, generatedAtUtc } = {}) {
  const norm = dedupSort(members);
  return { members: norm, tuple: {
    runId: runId ?? null, attempt: attempt ?? null, headSha: headSha ?? null,
    sourceRole: role ?? null, authoritySetHash: memberHash(norm), completeness: completeness ?? null,
    memberCount: norm.length, universeHash: universeHash ?? null, generatedAtUtc: generatedAtUtc ?? null } };
}

/**
 * PURE authority-artifact VALIDATOR (D-337 Blocker 1/2): an authority may become a
 * deletion basis ONLY if GENUINE - the self-reported hash is RECOMPUTED (never trusted),
 * memberCount matches members.length, sourceRole is the correct non-swappable role, the
 * tuple is tied to THIS frozen candidate universe (universeHash), the full tuple is
 * well-formed, and every member owner is inside the frozen owner set. Any failure => not
 * valid => the reconciler treats the authority as INCOMPLETE (ZERO_PUBLICATION).
 */
export function validateAuthorityArtifact(authority, { role, frozenUniverseHash, frozenOwners } = {}) {
  const t = authority && authority.tuple; const members = (authority && authority.members) || [];
  if (!t) return { ok: false, reason: 'missing tuple' };
  if (!isCandidateScopedComplete(t.completeness)) return { ok: false, reason: `not candidate-scoped complete (${t.completeness})` };
  if (t.sourceRole !== role) return { ok: false, reason: `wrong/swapped sourceRole (${t.sourceRole} != ${role})` };
  if (memberHash(members) !== t.authoritySetHash) return { ok: false, reason: 'authoritySetHash != recomputed member hash (tampered members)' };
  if (t.memberCount !== members.length) return { ok: false, reason: `memberCount ${t.memberCount} != members.length ${members.length}` };
  if (!t.universeHash || String(t.universeHash) !== String(frozenUniverseHash)) return { ok: false, reason: 'authority universeHash != frozen candidate universe hash' };
  if (t.runId == null || t.attempt == null || !t.headSha || !t.generatedAtUtc) return { ok: false, reason: 'authority tuple fields missing/ill-formed' };
  if (Array.isArray(frozenOwners)) { for (const o of extractOwners(members)) if (!frozenOwners.includes(o)) return { ok: false, reason: `authority owner '${o}' outside frozen universe owners` }; }
  return { ok: true, reason: 'valid' };
}

export const CASCADE_TUPLE_FOREIGN = 'C4_STAGE2_CASCADE_TUPLE_FOREIGN';
// D-338 Blocker 1: a missing/unreadable cascade tuple is a BROKEN cascade => ZERO_PUBLICATION (fail-closed), NOT a
// dormant no-op. The producer ALWAYS emits a tuple+manifest; dormant = a validated manifest, never tuple absence.
export const CASCADE_TUPLE_MISSING = 'C4_STAGE2_CASCADE_TUPLE_MISSING';
export const CENSUS_SKIP_FORBIDDEN = 'C4_STAGE2_CENSUS_SKIP_FORBIDDEN';
// D-339: a foreign / tampered / publishable:false / non-empty-ledger / tuple-mismatched dormant manifest must NOT be mis-accepted as a legitimate dormant on a cache hit.
export const DORMANT_MANIFEST_INVALID = 'C4_STAGE2_DORMANT_MANIFEST_INVALID';
/**
 * PURE cascade-tuple key + resolver (D-337 Blocker 4 REAL cross-cascade fix). The C4-S2
 * run/attempt/head tuple that SELECTS which immutable manifest to load is keyed by the
 * CONSUMING stage's OWN upstream run id (harvest->process->aggregate->upload each hop keyed
 * by the producer's run id = the consumer's upstream). A concurrent SAME-HEAD cascade has
 * different run ids at every hop, so it writes DIFFERENT keys and can NEVER overwrite/redirect
 * this cascade's tuple. NEVER head-keyed (a head-only pointer is overwritable => manifest redirect).
 */
export function cascadeTupleKey(upstreamRunId) { return `state/_handoff/c4-stage2/${upstreamRunId}/tuple.json`; }
export function resolveCascadeTuple({ store = {}, upstreamRunId, headSha } = {}) {
  const t = store[cascadeTupleKey(upstreamRunId)]; // per-hop keyed: un-overwritable by a concurrent same-head cascade
  // D-338 Blocker 1 (was fail-OPEN `ok:true, tuple:null`): a consumer-side missing/unreadable tuple = broken
  // cascade => ZERO_PUBLICATION. Fail-closing does NOT break dormant cycles (dormant = validated manifest, not absence).
  if (!t) return { ok: false, terminal: CASCADE_TUPLE_MISSING, reason: 'cascade tuple absent => ZERO_PUBLICATION' };
  if (String(t.headSha) !== String(headSha)) return { ok: false, terminal: CASCADE_TUPLE_FOREIGN, reason: `cascade tuple head '${t.headSha}' != current head '${headSha}' (foreign)` };
  if (t.runId == null || t.attempt == null) return { ok: false, terminal: CASCADE_TUPLE_FOREIGN, reason: 'cascade tuple missing run/attempt' };
  return { ok: true, tuple: t, manifestKey: `${t.runId}-${t.attempt}-${t.headSha}`, reason: 'cascade-bound' };
}

/**
 * PURE census-skip guard verdict (D-338 Bl1 / D-339 / D-340): both factory-upload guards' DECISION and the LAST
 * reachable cache-hit fail-open. Broken cascade / census+cache-reuse => terminal; a dormant manifest authorizes cache
 * REUSE only if validateDormantManifest attests a genuine current-cycle no-op (full manifest in, never a bare boolean).
 */
export function censusSkipGuardVerdict({ resolve, manifest, skipCompute } = {}) {
  if (!resolve || resolve.ok !== true) return { terminal: (resolve && resolve.terminal) || CASCADE_TUPLE_MISSING };
  const tuple = resolve.tuple || {};
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || typeof manifest.censusRequested !== 'boolean') return { terminal: DORMANT_MANIFEST_INVALID, reason: 'manifest malformed / censusRequested not a boolean' };
  if (manifest.censusRequested === true) return skipCompute === true ? { terminal: CENSUS_SKIP_FORBIDDEN } : { ok: true, dormant: false };
  const v = validateDormantManifest(manifest, tuple);
  return v.ok ? { ok: true, dormant: true } : { terminal: DORMANT_MANIFEST_INVALID, reason: v.reason };
}
// PURE dormant-manifest validator (D-339 conds 4-10 + D-340 #5 three-way): dormant cache REUSE only as a genuine no-op.
// eqTuple String()-compares every field, FAILS a null/undefined one (null-binding rejected); binding/universe/resolved tuple MUTUALLY corroborate.
const eqTuple = (a, b) => !!a && !!b && a.runId != null && a.attempt != null && a.headSha != null &&
  String(a.runId) === String(b.runId) && String(a.attempt) === String(b.attempt) && String(a.headSha) === String(b.headSha);
function validateDormantManifest(manifest, tuple) {
  const b = manifest.binding, u = manifest.universe, cc = (manifest.reports && manifest.reports.count_contract) || {};
  const checks = [
    [manifest.censusRequested === false, 'censusRequested !== false'],                                   // cond 4
    [manifest.publishable === true, 'not publishable'],                                                  // cond 5
    [eqTuple(b, tuple), 'binding tuple != resolved cascade tuple'],                                      // cond 6
    [eqTuple(u, tuple), 'universe tuple != resolved cascade tuple'],                                     // cond 7
    [eqTuple(b, u), 'binding tuple != universe tuple (three-way corroboration)'],                        // D-340 #5
    [verifyUniverseHash(u) === true, 'universe hash invalid/tampered'],                                  // cond 8
    [Array.isArray(manifest.ledger) && manifest.ledger.length === 0 && Array.isArray(manifest.removals) && manifest.removals.length === 0, 'non-empty ledger/removals'], // cond 9
    [cc.removed_count === 0 && cc.ledger_member_count === 0, 'count-contract attests removals/exclusions'], // cond 10
  ];
  for (const [ok, reason] of checks) if (!ok) return { ok: false, reason };
  return { ok: true };
}

export const HARVEST_SELECTION_INCOMPLETE = 'C4S2_HARVEST_SELECTION_INCOMPLETE';
/**
 * PURE harvest-run/attempt selection (D-338 Blocker 2). The automatic workflow_run event is AUTHORITATIVE:
 * its id + run_attempt name the EXACT triggering harvest attempt. A MANUAL dispatch MUST carry BOTH run_id AND
 * run_attempt - there is NO `gh run list` latest fallback and NO default attempt 1 (a failed attempt-1 that
 * wrote its manifest could otherwise be replayed as a deletion authority). Any missing selector => fail-closed.
 */
export function resolveHarvestSelection({ eventName, inputRunId, inputRunAttempt, workflowRunId, workflowRunAttempt } = {}) {
  const ne = v => v != null && String(v).trim() !== '' && String(v) !== 'null';
  if (eventName === 'workflow_run') {
    if (!ne(workflowRunAttempt)) return { ok: false, terminal: HARVEST_SELECTION_INCOMPLETE, reason: 'workflow_run event missing run_attempt => fail-closed' };
    return { ok: true, runId: String(workflowRunId), attempt: String(workflowRunAttempt), source: 'workflow_run' };
  }
  if (!ne(inputRunId) || !ne(inputRunAttempt)) return { ok: false, terminal: HARVEST_SELECTION_INCOMPLETE, reason: 'manual dispatch requires explicit run_id AND run_attempt (no latest, no default-1) => fail-closed' };
  return { ok: true, runId: String(inputRunId), attempt: String(inputRunAttempt), source: 'manual' };
}

export const HARVEST_ATTEMPT_INELIGIBLE = 'C4S2_HARVEST_ATTEMPT_INELIGIBLE';
/**
 * PURE eligibility assertion for a MANUAL-dispatch harvest attempt (D-338 Blocker 2): the operator-named
 * run/attempt must be the EXACT Factory-1/4 Harvest attempt on main that concluded SUCCESS at the current
 * head - a failed / foreign / other-attempt run that merely wrote a manifest is NEVER a deletion authority.
 * ALL conditions AND-gated; any miss => fail-closed. (workflow_run path is already conclusion-gated upstream.)
 */
export function assertHarvestAttemptEligible({ apiRun, expectRunId, expectAttempt, expectHeadSha, expectWorkflowName = 'Factory 1/4 - Harvest', expectBranch = 'main' } = {}) {
  const r = apiRun || {};
  const checks = [
    [!!apiRun, 'no api run'], [String(r.id) === String(expectRunId), 'run id mismatch'],
    [String(r.run_attempt) === String(expectAttempt), 'run_attempt mismatch'], [r.name === expectWorkflowName, 'workflow name mismatch'],
    [r.head_branch === expectBranch, 'head_branch mismatch'], [r.conclusion === 'success', 'conclusion != success'],
    [String(r.head_sha) === String(expectHeadSha), 'head_sha mismatch'],
  ];
  for (const [ok, reason] of checks) if (!ok) return { ok: false, terminal: HARVEST_ATTEMPT_INELIGIBLE, reason };
  return { ok: true };
}
