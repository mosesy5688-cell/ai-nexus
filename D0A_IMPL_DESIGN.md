# PR-D0a Implementation Design Note (source_trail evidence carrier FOUNDATION)

Spec authority: `L2_D0_SOURCE_TRAIL_SPEC_2026-06-08.md` v2 R4-RATIFIED. This note resolves the
CONCRETE choices the spec left open, for PM review, BEFORE code. Scope = PR-D0a ONLY (carrier +
dictionary + enums + edge_id + threading Rust+JS lockstep + canary in WARN). NO D0b/D0c scope.

ASCII-only. CES <= 250 lines/file.

---

## 0. The keystone decision — where the "per-shard evidence dictionary" lives

The spec (§2B) says the dictionary + enum tables + interned source_url live "in the shard header /
sidecar, stored ONCE per shard". The concrete corpus reality (verified at f32b31dc):

- BOTH served sinks derive from ONE artifact: `cache/mesh/graph.json(.zst)`.
  - Sink 1 `site_metadata.mesh_graph` = that exact blob, injected verbatim by `pack-utils.js:188`.
  - Sink 2 `entities.ui_related_mesh` = baked by `mesh-profile-baker.js` reading `graph.json`, then
    distilled by `v25-distiller.js` resolveMeshEdge.
- There is exactly ONE graph blob (not N physical shards) at today's scale; "per-shard" in the spec
  generalizes to "per-graph-artifact". The dictionary is therefore a **single top-level
  `evidence_dict` object on the graph artifact** (`graph.json`), built at the single owning stage
  (the mesh-graph generator — Rust primary / JS fallback), and it travels with the blob into
  `site_metadata.mesh_graph`. The baker reads `graph.evidence_dict`, carries the SAME integer refs
  onto `ui_related_mesh`, and re-emits the dictionary so the per-entity sink is self-contained for
  the canary. **DECISION: dictionary = `graph.evidence_dict` (top-level sidecar on the graph blob),
  re-stamped onto each baked shard's profile stream header. One dictionary, one ref-space.**

This keeps the HARD §2B invariant: refs are small integers on every edge; the fat EvidenceElement
objects + enum spellings + interned source_url strings exist ONCE in `evidence_dict`.

---

## 1. Shard evidence dictionary format (exact storage + shape)

`evidence_dict` is a top-level key on `graph.json` (and re-emitted on the baked profile shard
stream as a header line / sidecar — see §3). Shape:

```
evidence_dict = {
  v: 'd0-evidence-v0',          // dictionary format version (governed bump)
  weights_version: 'identity-weights-v1',  // FROZEN METHOD_WEIGHTS revision (§2.1)
  producers: ['relations_generator','rel_extractor','mesh_graph_explains',
              'mesh_graph_featured_in','reverse_edge_projector','report_injection'],
  methods:   ['exact_source_url_xref','derived_from_xref','cites_xref','uses_xref',
              'shared_source_url_unverified','declared_dependency','leaderboard_membership',
              'keyword_mention','reverse_of','structural_injection','report_chain'],
  signals:   ['base_model', ...],    // interned signal vocab (integer-coded)
  source_urls: ['https://...', ...], // interned, dedup-heavy (one entity's many edges share its URL)
  elements: [ EvidenceElement_compact, ... ]  // the deduped element table; ref = index here
}
```

An `EvidenceElement` is stored in the `elements[]` table in COMPACT integer-coded form (enums and
source_url are indices into the sibling tables, NOT spelled strings):

```
EvidenceElement_compact = [signalIdx, value, sourceFieldIdx, methodIdx, weight, producerIdx, sourceUrlIdx, observedAt]
```
- `value` (the cross-ref value, e.g. 'meta-llama/Llama-2-7b') and `weight` (0..1 from
  METHOD_WEIGHTS) are the only inline scalars; everything else is an integer index.
- `sourceFieldIdx` indexes the same interned `signals`+field vocab pool as `signalIdx` would (we
  intern field names into `signals` too — source_field == source_locator per §2A, reuse). To keep
  it simple and unambiguous we use ONE interned-string pool `strings[]` for signal AND source_field
  AND value-less labels; `source_urls[]` stays a SEPARATE pool because it dedups far more heavily
  and the canary inspects it independently. **DECISION: two intern pools — `strings` (signal +
  source_field) and `source_urls`; enums (`producers`/`methods`) are their own closed tables.**
- `observedAt` = null in D0a (FRESHNESS RESERVED, §11). Stored as-is.

The LOGICAL EvidenceElement (the §2A object an EvidenceBuilder produces before interning) is the
human-readable `{signal,value,source_field,method,weight,producer,source_url,observed_at}`. The
interner converts logical -> compact + returns the integer ref.

**Dedup / interning**: an element is keyed by a stable string
`signal|value|source_field|method|producer|source_url` (observed_at excluded — null in v0). First
occurrence appends to `elements[]` and returns its index; repeats return the existing index. enum
and string pools intern by value (Map<string,int>). This is the assertion discipline
(`assertion-rules.js:100` stores `weights_version` ONCE) generalized to the whole evidence table.

> **Revised decision (simpler intern pool)**: to keep the carrier and canary trivial, the FIRST
> implementation interns signal/source_field as plain indices into `strings[]`, and stores
> `producers`/`methods` as closed enum tables indexed by the producer/method ENUM ORDINAL (a frozen
> ordering), NOT by intern order — so a producer ordinal is stable across cycles for dedup. The
> canary validates `methodIdx` is a valid index whose method is in MethodEnum, `producerIdx` valid
> in ProducerEnum, and `source_field` (resolved from `strings[sourceFieldIdx]`) non-empty.

---

## 2. Carrier wire encoding (the widened edge shape)

The edge gains TWO carrier slots: `source_trail_refs` (compact integer index array into
`evidence_dict.elements`) and `edge_id`.

**Array path** (relations-generator addEdge, Rust emit, mesh import) widens the 3-tuple:
```
[ target, type, conf, source_trail_refs, edge_id ]
//   0      1    2          3 (int[])        4 (string)
```
Slot 3 = `[refIdx, ...]` (>=1 in honest data; structural sentinel still mints exactly 1). Slot 4 =
`edge_id`. Readers that only know slots 0/1/2 (legacy dedup) keep working — additive widen.

**Object path** (mesh-graph-generator JS fallback edges, baked relations, reverse edges) adds keys:
```
{ target, type, weight, source_trail, edge_id }   // source_trail == the refs array; key named per audit
```
- Object key is `source_trail` (the audit's §3 row name) holding the SAME integer ref array.
- `target_type`/`confidence`/name/icon etc. unchanged.

resolveMeshEdge return shape gains `source_trail` (the refs) so it reaches `ui_related_mesh` and the
served entity API (`entity-projection.ts relations.related` passthrough — acceptance #5).

---

## 3. Rust <-> JS dictionary handoff (the hardest part)

**Problem**: the dictionary is built DURING the bake while BOTH Rust (primary) and JS (fallback)
emit edges. Refs minted by Rust and refs minted by JS must resolve against the SAME dictionary, and
Rust-primary + JS-fallback must stay at parity.

**Key realization (resolves the handoff cleanly)**: in this pipeline Rust and JS do NOT BOTH run in
the same cycle. They are PRIMARY/FALLBACK at each stage — exactly one path executes per stage per
cycle (JS calls Rust FFI; on FFI success the JS fallback body is skipped; on FFI miss JS runs).
There is no cross-process ref merge to coordinate. So the rule is:

> **The stage that OWNS edge minting also OWNS its slice of the dictionary, in whichever language
> ran. Rust and JS use IDENTICAL deterministic interning so the SAME logical element yields the SAME
> integer index regardless of which language minted it.** Determinism is guaranteed by: (a) frozen
> enum ORDINALS (producer/method ordinals are constants compiled into BOTH Rust and JS, §1), and
> (b) interning the variable pools (`strings`, `source_urls`, `elements`) in **first-seen append
> order during a single deterministic pass** over the same input in the same order. Because both
> impls iterate the same `explicit.json` edges in the same order and apply the same producer rules,
> the produced dictionaries are byte-equivalent.

**Two-stage dictionary ownership (matches the two-stage pipeline):**

1. **relations stage** (`relations-generator.js` + Rust `relations.rs`): in-`rel()` producers mint
   the per-edge trail (refs into a dictionary built HERE). This dictionary is written into
   `explicit.json` as `explicit.evidence_dict` alongside `nodes`/`edges`. The edge arrays in
   `explicit.edges` carry slot[3]=refs (indices into `explicit.evidence_dict`) + slot[4]=edge_id.
   - JS builds the dict in `addEdge`/the JS->Rust reconstruction; Rust reads `RawRelation.source_trail`
     (the refs, already-interned indices passed THROUGH from JS) — Rust does NOT re-intern in the
     relations stage; it passes the refs+edge_id verbatim into the emitted array. (JS owns the
     relations-stage dictionary; Rust is a pure graph-shaper there. This is the existing division of
     labor: "JS side still extracts relations ... Rust builds the graph" — relations.rs:38.)
   - **edge_id** is computed by JS in `addEdge` (the choke point) so it is identical regardless of
     Rust/JS graph build. Rust passes it through.

2. **mesh stage** (`mesh-graph-generator.js` + Rust `mesh_graph.rs`): imports `explicit` (refs +
   `evidence_dict` come in TOGETHER), then MINTS the out-of-rel edges (EXPLAINS, FEATURED_IN). Those
   new elements are APPENDED to the imported dictionary (the mesh stage OWNS the structural-edge
   slice). The merged `evidence_dict` is written onto `graph.json`.
   - Both Rust `mesh_graph.rs` and JS `mesh-graph-generator.js` carry the imported dict forward and
     append EXPLAINS/FEATURED_IN structural sentinels using the SAME deterministic interner +
     enum ordinals -> same indices. Whichever path runs, the served `graph.evidence_dict` is the
     same. (Per-cycle only ONE path runs, so there is no within-cycle Rust/JS index collision; the
     PARITY tests assert the two paths produce equal dictionaries + edge refs for the same input.)

3. **baker stage** (`mesh-profile-baker.js`): reads `graph.evidence_dict` + edge slot[3]/[4],
   carries refs THROUGH bakeEdge onto each baked relation object, and RE-EMITS `evidence_dict` once
   per profile-shard (a header element prepended to the JSONL stream, or a sidecar) so the
   per-entity sink is self-contained for the canary + serve. Reverse edges in D0a get a MINIMAL
   structural sentinel ref (full reverse-references-forward-edge is D0b) — they do NOT yet reference
   the forward edge_id.

**Net**: ONE ref-space per cycle, owned stagewise, deterministic in both languages. No live
cross-language merge needed because exactly one language runs per stage per cycle; parity tests lock
the two languages to identical output.

---

## 4. edge_id (§5)

`edge_id = hash(canonical_source_id + "\0" + relation_type + "\0" + canonical_target_id)`.
- **Hash**: SHA-256, first 16 hex chars (64-bit) — matches the assertion `assertionId` discipline
  (`assertion-rules.js:52` sha256 sliced) and is cheap/deterministic. 16 hex = 64 bits is ample for
  edge dedup at 1M-10M edges (birthday collision ~ negligible; this is a dedup/reference key, not a
  security primitive).
- **Where computed**: JS in `relations-generator.js addEdge` (the single choke point, after ids are
  canonicalized by the producers). Rust receives it via `RawRelation.edge_id` and passes it through.
  For Rust-minted structural edges (EXPLAINS/FEATURED_IN) Rust computes it with a byte-identical
  SHA-256 over the same `src\0type\0tgt` string (a tiny shared helper in `mesh_graph.rs`); the JS
  fallback mints the identical value. A shared JS helper `edgeId(src,type,tgt)` lives in a new tiny
  `lib/evidence-carrier.js`; the Rust helper mirrors it. **Parity test asserts JS edgeId == Rust
  edge_id for the same triple.**

---

## 5. Producers — MINIMAL valid trail (D0a scope)

In-`rel()` edges (BASED_ON/TRAINED_ON/CITES/USES/EVALUATED_ON/DEMO_OF/IMPLEMENTS/STACK/DEP/
FEATURES/EXPLAIN) get ONE EvidenceElement from in-scope evidence:
- `signal` = the source field name (base_model / datasets / arxiv_refs / ...),
- `value` = the raw ref value,
- `source_field` = same field name (== source_locator),
- `method` = a sane per-verb mapping into the FROZEN/extended METHOD enum (BASED_ON->derived_from_xref,
  CITES->cites_xref, USES/DEMO_OF/IMPLEMENTS/STACK/DEP->uses_xref or declared_dependency,
  TRAINED_ON->derived_from_xref, EVALUATED_ON->leaderboard_membership, FEATURES->keyword_mention),
- `weight` = METHOD_WEIGHTS[method] (THROW on unknown — never a silent scalar),
- `producer` = `rel_extractor` (or `relations_generator` for report edges),
- `source_url` = the SOURCE entity source_url (from `projectEntityForRelations` out.source_url,
  registry-loader.js:245); null when absent (honest),
- `observed_at` = null (RESERVED).

Structural / out-of-rel edges (report FEATURES, FOLLOWS, EXPLAINS, FEATURED_IN, TRENDING) get a
MINIMAL STRUCTURAL SENTINEL element: `method=structural_injection` (or `report_chain` for FOLLOWS),
`source_url=null`, `source_field` = the structural source (`report--<day>` / `knowledge-links.json`
/ `reports`), `producer` = the minting stage enum. So NO edge is flagged missing by the canary.
(Refined sentinels + full honest population = D0b.)

method->weight additions needed in METHOD_WEIGHTS (governed version bump, same frozen table):
`declared_dependency`, `leaderboard_membership`, `keyword_mention`, `reverse_of`,
`structural_injection`, `report_chain`. I will add them with conservative sub-1.0 weights
(structural sentinels: low weight; declared_dependency 0.5; leaderboard_membership 0.5;
keyword_mention 0.3; reverse_of 0.0 placeholder — reverse_of unused in D0a). **PM FLAG (1)**: I am
adding these to the existing `METHOD_WEIGHTS` under a bumped `IDENTITY_WEIGHTS_VERSION`
(`identity-weights-v2`). The assertion generator already pins v1 into shipped assertions, so a bump
re-stamps NEW assertions with v2 but does NOT mutate shipped weights (no v1 key changes) — confirm
this is the intended governance path vs a SEPARATE `mesh-method-weights` table.

---

## 6. Canary in WARN mode (§9, WARN-first per §13)

Add a presence check over BOTH baked sinks in `verify-mesh-canary.js` that REPORTS coverage %
(per producer + per sink) and logs gaps, but does NOT exit 1:
- Sink 1 graph-blob loop: scan every edge, count those with `source_trail_refs.length >= 1` whose
  every ref RESOLVES to a `graph.evidence_dict.elements[ref]` whose method in MethodEnum, producer in
  ProducerEnum, source_field non-empty. Report covered/total + per-producer histogram.
- Sink 2 ui_related_mesh loop: same over served edges, reading the baked-shard / served dict.
- Emits `[VERIFY] source_trail coverage (WARN): <pct>% ...` and per-producer gaps. NO `check(...)`
  that flips pass=false; uses a WARN logger so the bake never fails on coverage. The bake-FAIL flip
  + negative-fixture gate = PR-D0b.
- A standalone helper `assertEdgeTrail(edge, dict)` is exported so the UNIT negative fixture can
  prove it WOULD flag an empty/unresolvable ref (tested even though prod mode is WARN).

---

## 7. File-by-file change plan (§3 stages)

NEW:
- `scripts/factory/lib/evidence-carrier.js` — the shared D0 carrier kernel (JS side): enum
  ordinals (PRODUCERS/METHODS), `EvidenceDict` builder (intern + dedup), `evidenceElement(...)`
  logical builder reusing assertion-weights, `edgeId(src,type,tgt)` (sha256), `methodForVerb(verb)`
  + `structuralSentinel(...)`, and `assertEdgeTrail(edge,dict)` for the canary. Keeps every other
  file small (CES).

CHANGED — JS:
- `scripts/factory/lib/assertion-weights.js` — add the new mesh methods to METHOD_WEIGHTS + bump
  version (PM FLAG 1).
- `scripts/factory/lib/relations-generator.js` — addEdge widens to carry refs + edge_id; build the
  relations-stage `evidence_dict`; report FEATURES/FOLLOWS sentinels; write `evidence_dict` into the
  Rust input + the JS-fallback `explicit.json`; thread refs into `relsFromEdges` for Rust.
- `scripts/factory/lib/relation-extractors.js` — `rel()`/`extractEntityRelations` attach a minimal
  EvidenceElement per edge (in-scope source_url + field + method); pass source entity for source_url.
- `scripts/factory/lib/mesh-graph-generator.js` — import `explicit.evidence_dict`; preserve slot[3]/[4]
  on array AND object paths; mint EXPLAINS/FEATURED_IN with sentinel refs (append to dict); write
  `graph.evidence_dict`.
- `scripts/factory/mesh-profile-baker.js` — bakeEdge reads slot[3]/[4], forwards `source_trail` +
  `edge_id`; re-emit `evidence_dict` per shard (header line); reverse edges get a sentinel ref.
- `scripts/factory/lib/v25-distiller.js` — pass the edge ref to resolveMeshEdge; carry it onto the
  served node; pass the served dict through.
- `scripts/factory/lib/mesh-resolve-filter.js` — resolveMeshEdge returns `source_trail` (+ edge_id);
  isResolvedMeshNode unchanged (presence is the WARN canary's job, not the resolve gate, in D0a).
- `scripts/factory/lib/verify-mesh-canary.js` — add the WARN coverage check over both sinks.

CHANGED — Rust (`rust/satellite-tasks/src/`):
- `relations.rs` — `RawRelation` adds `source_trail: Value` + `edge_id: String`
  (`#[serde(default)]`); emit widened arrays `[target,type,conf,source_trail,edge_id]`; pass the
  imported `evidence_dict` through into `explicit`. (Do NOT thread the DEAD `reverse` map — §4.)
- `mesh_graph.rs` — preserve slot[3]/[4] on imported edges; mint EXPLAINS/FEATURED_IN with sentinel
  refs appended to the carried dict; compute edge_id (sha256 helper) for minted edges; write
  `graph.evidence_dict`. Add a tiny shared `evidence` mod or inline helpers (CES-bounded; sha2/hex
  already? — check Cargo).

CHANGED — TS (serve):
- `src/lib/entity-projection.ts` — `relations.related` already passes `ui_related_mesh` through;
  confirm the served node retains `source_trail` (passthrough only, no shape change needed —
  acceptance #5). No logic change beyond verifying the field survives `safeJsonParse`.

Tests (NEW): `tests/unit/source-trail-carrier.test.ts` (or extend mesh.test) — Rust==JS parity on
edge shape + refs; dictionary resolve (a ref -> valid element); negative fixture (empty/unresolvable
ref WOULD flag); edge_id determinism JS==Rust triple.

---

## 8. Decisions for PM to scrutinize
1. **(flagged §5)** New mesh methods added to the EXISTING `METHOD_WEIGHTS` under a bumped
   `identity-weights-v2` vs a separate `mesh-method-weights` table. I chose the bump (single frozen
   table, the spec says "add to the SAME frozen table, versioned"). Confirm the version-bump
   governance is acceptable (does not re-score shipped assertions; only re-stamps new ones).
2. **Dictionary location** = `evidence_dict` top-level on `graph.json` (single graph artifact),
   re-emitted per baked profile-shard. Generalizes the spec's "per-shard header" to this pipeline's
   one-graph-blob reality. Confirm acceptable vs a separate sidecar file (a sidecar would need new
   pack-utils plumbing into site_metadata; the top-level key rides the existing `mesh_graph` blob
   for free and is the lowest-risk path that keeps both sinks self-contained).
3. **edge_id = sha256[:16] (64-bit)**. Sufficient for dedup/reference at corpus scale; flag if a
   full 128/256-bit id is wanted for future global uniqueness.
4. **Blob growth (acceptance #4 SHOULD, <=10%)**: compact refs + interned dict are the mitigation;
   D0a cannot be measured until the one re-bake (PR-D0a delivers WARN coverage; PM reads growth +
   coverage from that bake before D0b flips FAIL).
