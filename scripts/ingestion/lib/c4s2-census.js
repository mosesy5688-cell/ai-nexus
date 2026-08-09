/**
 * C4 Stage-2 (D-335/336): CANDIDATE-scoped census (request-only).
 *
 * Extracted VERBATIM from harvest-single.js (D-2026-0809-416): the producer-bound
 * escalation path had to be added to harvestSingle() and harvest-single.js was at
 * the CES Art 5.1 ceiling (250 lines). This census has nothing to do with the
 * streaming harvest loop, so it is the correct thing to move out. The behaviour,
 * the file paths it reads/writes and the log line are unchanged; harvest-single.js
 * re-exports `c4s2Census` so every existing import site keeps working.
 *
 * Reads the frozen universe owners (reconciler `freeze`), exhausts EACH owner's
 * model + dataset listing via the adapters' real Link-cursor pagination, writes the
 * dual-source authority artifacts (members + tuple + per-owner completeness +
 * universe-hash + metrics). Partial NEVER usable for deletion: an owner not
 * exhausted => that authority INCOMPLETE => ZERO_PUBLICATION.
 */

import fs from 'node:fs';
import { buildAuthorityArtifact, AUTHORITY_ROLE } from '../../factory/lib/c4s2-candidate-universe.js';

export async function c4s2Census() {
    const universe = JSON.parse(fs.readFileSync('data/state/c4-stage2/universe.json', 'utf8'));
    const owners = universe.owners || [];
    const { default: HuggingFaceAdapter } = await import('../adapters/huggingface-adapter.js');
    const { default: DatasetsAdapter } = await import('../adapters/datasets-adapter.js');
    const model = await new HuggingFaceAdapter().fetchCensusMembership({ authors: owners });
    const dataset = await new DatasetsAdapter().fetchCensusMembership({ authors: owners });
    // D-337 Blocker 3: authority-artifact producer = PURE helper (same memberHash the validator recomputes).
    const art = (role, res) => ({ ...buildAuthorityArtifact({ members: res.members, role, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, headSha: process.env.GITHUB_SHA, universeHash: universe.universeHash, generatedAtUtc: new Date().toISOString(), completeness: res.completeness }), metrics: res.metrics });
    fs.mkdirSync('data/state/c4-stage2', { recursive: true });
    fs.writeFileSync('data/state/c4-stage2/model-authority.json', JSON.stringify(art(AUTHORITY_ROLE.MODEL, model)));
    fs.writeFileSync('data/state/c4-stage2/dataset-authority.json', JSON.stringify(art(AUTHORITY_ROLE.DATASET, dataset)));
    console.log(`[C4-S2] census: owners=${owners.length} model=${model.members.length}(${model.completeness}) dataset=${dataset.members.length}(${dataset.completeness})`);
}
