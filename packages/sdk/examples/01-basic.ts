/**
 * Examples 1-4: basic search, candidate selection with constraints, compare,
 * and evidence retrieval. Run with: `tsx examples/01-basic.ts` (after building,
 * import from the package; here we import the source for clarity).
 *
 * REMINDER: these calls RETRIEVE candidates and evidence. The SDK does not pick
 * "the best" or guarantee compatibility — the caller makes the final decision.
 */
import { Free2AIClient } from "../src/index.js";

const client = new Free2AIClient(); // defaults to https://free2aitools.com

// (1) Basic search.
export async function basicSearch(): Promise<void> {
  const res = await client.search({ q: "small coding model", limit: 5 });
  console.log(`tier=${res.tier} total=${res.total_count} elapsed=${res.elapsed_ms}ms`);
  for (const r of res.results) {
    // fni_score is evidence; fni_s is ALWAYS null (a query-time baseline).
    console.log(`- ${r.name} (fni=${r.fni_score})`);
  }
}

// (2) Candidate selection with constraints. Evidence + caveats; you decide.
export async function selectWithConstraints(): Promise<void> {
  const res = await client.select({
    task: "summarize legal documents locally",
    constraints: { max_vram_gb: 24, license_type: "permissive", can_run_local: true },
    limit: 5,
    explain: true,
  });
  console.log(`interpreted as: ${res.task_interpreted}`);
  for (const e of res.entries) {
    // caveats and fni_summary are FACTUAL — not a recommendation.
    console.log(`#${e.rank} ${e.name}`, e.caveats ?? []);
  }
}

// (3) Compare a set of entities. Unresolved ids come back found:false (honest).
export async function compareEntities(): Promise<void> {
  const res = await client.compare({
    ids: ["meta-llama/Llama-3.1-8B", "mistralai/Mistral-7B-v0.1"],
  });
  for (const e of res.entities) {
    if (e.found) console.log(`${e.name}: fni=${e.fni_score}`);
    else console.log(`${e.id}: not found (honest absence)`);
  }
}

// (4) Evidence retrieval via getEntityEvidence (local, no extra network call).
export async function evidence(): Promise<void> {
  const entity = await client.getEntity({ id: "meta-llama/Llama-3.1-8B" });
  const ev = client.getEntityEvidence(entity);
  console.log("identity:", ev.canonical_id, "-", ev.identity_note);
  console.log("semantic factor:", ev.fni.factors.semantic, "(", ev.semantic_note, ")");
  console.log("stats:", ev.stats);
  console.log(ev.disclaimer);
}
