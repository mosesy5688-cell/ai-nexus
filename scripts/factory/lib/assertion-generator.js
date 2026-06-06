/**
 * Identity Assertion Generator (PR-C1) -- the L2 assertion producer.
 * Design: IDENTITY_LAYER_DESIGN_v3 B / C / D / G PR-C1.
 *
 * Runs in the 3/4 Aggregate path (satellite task, mirrors generateRelations:
 * consumes the SAME streamed entities). Emits two relation classes into an OWN
 * artifact (the `assertions` table -- NOT the dedup ledger, which is keyed
 * member_a and must hold NO assertion semantics):
 *   - SAME_AS    = exact_source_url_xref ONLY, on HARVEST-SET source_urls, between
 *                  two DISTINCT canonical_ids. Sparse BY DESIGN (certainty>coverage).
 *   - MANIFESTATION_OF = everything else, by construction (relation-class xrefs:
 *                  base_model lineage, paper CITES, model USES; + shared-but-
 *                  unprovable source_urls). Non-authoritative, verified:null.
 *
 * Dual-member-shard write (design D): each assertion -> shard(member_a) AND
 * shard(member_b), so a member_b lookup never fans out. EVALUATED_ON is BARRED
 * from identity entirely. Every assertion carries non-empty evidence[]; an
 * empty-evidence assertion is REJECTED at write and counted (canary). ASCII-only.
 */

import fs from 'fs/promises';
import path from 'path';
import { zstdCompress } from './zstd-helper.js';
import { normalizeId, getNodeSource } from '../../utils/id-normalizer.js';
import { computeMetaShardSlot } from './meta-shard-router.js';
import { META_SHARD_COUNT } from '../../../src/constants/shard-constants.js';
import {
    buildSameAs, buildManifestationOf, evidenceRow,
    isHarvestSetSourceUrl, isPaperPlaceholder,
} from './assertion-rules.js';

/** Relation-class cross-reference fields -> MANIFESTATION_OF method + target type. */
const MANIFESTATION_XREFS = [
    { fields: ['base_model'], targetType: 'model', method: 'derived_from_xref', signal: 'base_model' },
    { fields: ['arxiv_refs', 'paper_refs', 'references'], targetType: 'paper', method: 'cites_xref', signal: 'paper_ref' },
    { fields: ['models_used', 'models', 'model_id'], targetType: 'model', method: 'uses_xref', signal: 'model_use' },
];

function toArray(v) { return v == null ? [] : (Array.isArray(v) ? v : [v]); }
function isRef(v) { return typeof v === 'string' && v.length > 2; }

/**
 * Main entry. shardReader streams projected entities (same signature as
 * generateRelations). Two responsibilities per entity: (1) index its harvest-set
 * source_url for the cross-id SAME_AS pass; (2) emit its MANIFESTATION_OF xrefs.
 * SAME_AS is resolved AFTER the stream (needs the full source_url -> ids map).
 */
export async function generateAssertions(shardReader, outputDir = './output') {
    console.log('[ASSERTIONS C1] Generating identity assertions (streaming)...');
    const outDir = path.join(outputDir, 'cache', 'assertions');
    await fs.mkdir(outDir, { recursive: true });

    // source_url (harvest-set) -> Set<canonical_id>. Sparse: only entities whose
    // source_url is PROVABLY harvest-set (assertion-rules.isHarvestSetSourceUrl)
    // are indexed, so a back-derived URL can never seed a false SAME_AS (design B).
    const urlToIds = new Map();
    const shards = Array.from({ length: META_SHARD_COUNT }, () => []);
    const summary = {
        same_as: 0, manifestation_of: 0, assertions_empty_evidence: 0,
        evaluated_on_same_as: 0, paper_placeholder_same_as: 0,
        entities_scanned: 0, harvest_set_urls: 0,
    };
    const seen = new Set(); // assertion_id dedup (an id can recur across shards)

    const emit = (assertion) => {
        if (!assertion) { summary.assertions_empty_evidence++; return; } // rejected at build
        if (seen.has(assertion.assertion_id)) return;
        seen.add(assertion.assertion_id);
        if (assertion.relation === 'SAME_AS') summary.same_as++;
        else summary.manifestation_of++;
        // Dual-member-shard write: route by BOTH members so member_b never fans out.
        for (const member of [assertion.member_a, assertion.member_b]) {
            const slot = computeMetaShardSlot(member, META_SHARD_COUNT);
            shards[slot].push(assertion);
        }
    };

    await shardReader(async (entities) => {
        for (const e of entities) {
            const id = e.id || e.slug;
            if (typeof id !== 'string' || id.length < 3) continue;
            summary.entities_scanned++;
            // (1) harvest-set source_url -> SAME_AS candidate index (paper placeholder
            // never indexed: D7 keeps it out of SAME_AS at the source).
            if (!isPaperPlaceholder(id) && isHarvestSetSourceUrl(e)) {
                summary.harvest_set_urls++;
                let set = urlToIds.get(e.source_url);
                if (!set) { set = new Set(); urlToIds.set(e.source_url, set); }
                set.add(id);
            }
            // (2) MANIFESTATION_OF: relation-class cross-references (never SAME_AS).
            emitManifestations(e, id, emit);
        }
    }, { relations: true, assertions: true });

    // SAME_AS pass: a source_url shared by >=2 distinct canonical_ids is one
    // real-world artifact harvested under two prefixes. Pairwise within each group.
    for (const [url, idSet] of urlToIds) {
        const ids = [...idSet];
        if (ids.length < 2) continue;
        for (let i = 0; i < ids.length; i++)
            for (let j = i + 1; j < ids.length; j++)
                emit(buildSameAs(ids[i], ids[j], url));
    }

    await writeAssertionShards(shards, outDir, summary);
    logSummary(summary);
    return summary;
}

/** Emit MANIFESTATION_OF assertions for an entity's relation-class xref fields. */
function emitManifestations(e, id, emit) {
    const type = e.type || 'model';
    for (const spec of MANIFESTATION_XREFS) {
        for (const field of spec.fields) {
            for (const raw of toArray(e[field])) {
                if (!isRef(raw)) continue;
                const targetId = normalizeId(raw, getNodeSource(raw, spec.targetType), spec.targetType);
                if (!targetId || targetId === id) continue;
                const ev = [evidenceRow(spec.signal, raw, field, spec.method)];
                emit(buildManifestationOf(id, targetId, spec.method, ev));
            }
        }
    }
}

/** Write each non-empty shard as JSONL.zst (one assertion/line). Streaming-friendly. */
async function writeAssertionShards(shards, outDir, summary) {
    let written = 0;
    for (let slot = 0; slot < shards.length; slot++) {
        const list = shards[slot];
        if (list.length === 0) continue;
        const jsonl = list.map((a) => JSON.stringify(a)).join('\n') + '\n';
        const name = `assertions-${String(slot).padStart(2, '0')}.jsonl.zst`;
        await fs.writeFile(path.join(outDir, name), await zstdCompress(jsonl));
        written += list.length;
        shards[slot] = null; // release
    }
    summary.shard_rows_written = written; // dual-member => ~2x assertion count
    await fs.writeFile(path.join(outDir, '_summary.json'), JSON.stringify(summary, null, 2));
}

function logSummary(s) {
    console.log(`  [ASSERTIONS] scanned=${s.entities_scanned} harvest_set_urls=${s.harvest_set_urls}`);
    console.log(`  [ASSERTIONS] SAME_AS=${s.same_as} MANIFESTATION_OF=${s.manifestation_of} ` +
        `empty_evidence=${s.assertions_empty_evidence} rows=${s.shard_rows_written || 0}`);
    if (s.assertions_empty_evidence > 0) {
        console.error(`  [ASSERTIONS] FATAL: ${s.assertions_empty_evidence} empty-evidence assertions rejected (canary).`);
    }
}
