/**
 * Canonical-ID Fixpoint Regression Test (Phase-2 Identity Block-1)
 *
 * Guards the contract the entity API now exposes as `canonical_id`: the served
 * entities.id IS the deterministic normalized identity KEY, i.e. a normalizeId
 * fixpoint. For a canonical id, re-normalizing it (with its own derived source)
 * must return it unchanged:
 *
 *     normalizeId(id, getNodeSource(id, type), type) === id
 *
 * A live round-trip gate proved this at 100.00% over ~470 live ids across all 5
 * types {model, dataset, paper, tool, benchmark}. This test pins a hardcoded,
 * representative subset so the invariant runs OFFLINE in CI (no network / no DB).
 *
 * It also pins ADVERSARIAL non-fixpoints (uppercase, version suffix) that MUST
 * change under normalization -- proving the assertion actually discriminates and
 * would catch a regression that broke the fixpoint property.
 *
 * normalizeId/getNodeSource LOGIC is unchanged by #2154 (which only added
 * side-effect provisional-source counters), so importing the live normalizer is
 * correct. ASCII-only per CES Art 8.1.
 */
import { normalizeId, getNodeSource } from './id-normalizer.js';

// Confirmed-live canonical fixpoints, one per type plus both paper forms.
// Each MUST satisfy normalizeId(id, getNodeSource(id,type), type) === id.
const FIXPOINTS = [
    { type: 'model', id: 'hf-model--meta-llama--llama-3' },
    { type: 'dataset', id: 'hf-dataset--openai--gsm8k' },
    { type: 'tool', id: 'gh-tool--vllm-project--vllm' },
    { type: 'benchmark', id: 'benchmark--openllm--mmlu_pro' },
    // Both paper forms are confirmed live fixpoints (gate-verified).
    { type: 'paper', id: 'arxiv-paper--arxiv--2401.12345' },
    {
        type: 'paper',
        // `--unknown--` is the HONEST placeholder for unresolved upstream
        // identity (canonical FORM, not a real arxiv id). It is a fixpoint.
        id: 'arxiv-paper--unknown--abcdef0123456789abcdef0123456789abcdef01',
    },
];

// Adversarial NON-fixpoints: these MUST change under normalization, so the
// test proves it discriminates (a broken normalizer that became identity would
// be caught here as a failure).
const NON_FIXPOINTS = [
    { type: 'model', id: 'HF-Model--Foo--Bar', why: 'uppercase normalizes down' },
    { type: 'paper', id: 'arxiv-paper--2401.12345v2', why: 'version suffix stripped' },
];

console.log('Running canonical-id fixpoint regression test...\n');

let passed = 0;
let total = 0;

for (const t of FIXPOINTS) {
    total++;
    const src = getNodeSource(t.id, t.type);
    const out = normalizeId(t.id, src, t.type);
    const ok = out === t.id;
    if (ok) {
        console.log(`[PASS] fixpoint (${t.type}): ${t.id}`);
        passed++;
    } else {
        console.error(`[FAIL] fixpoint (${t.type}): ${t.id}`);
        console.error(`   source:   "${src}"`);
        console.error(`   got:      "${out}"`);
        console.error(`   expected: "${t.id}" (unchanged)`);
    }
}

for (const t of NON_FIXPOINTS) {
    total++;
    const src = getNodeSource(t.id, t.type);
    const out = normalizeId(t.id, src, t.type);
    // Discriminator: a non-canonical input MUST be changed by normalization.
    const ok = out !== t.id;
    if (ok) {
        console.log(`[PASS] non-fixpoint (${t.why}): ${t.id} -> ${out}`);
        passed++;
    } else {
        console.error(`[FAIL] non-fixpoint NOT discriminated (${t.why}): ${t.id}`);
        console.error(`   normalizeId returned the input unchanged; test cannot detect regressions.`);
    }
}

console.log(`\nResults: ${passed}/${total} passed.`);
if (passed !== total) {
    process.exit(1);
}
