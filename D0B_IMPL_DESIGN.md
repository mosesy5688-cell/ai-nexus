# PR-D0b Implementation Design Note (source_trail FULL POPULATION + Fusion/ui_related_mesh circuit)

Spec authority: `L2_D0_SOURCE_TRAIL_SPEC_2026-06-08.md` v2 R4-RATIFIED (sec 13 PR-D0b scope).
Branch: `fix/d0b-source-trail-populate` off main `1e47b66b` (which HAS PR-D0a). Worktree `G:\ai-nexus-d0b`.

This note is the REPOSITORY-TRUTH diagnosis (DIAGNOSE BEFORE FIX) for PM review, BEFORE code.
ASCII-only. CES <= 250 lines/file. All claims grounded in file:line at `1e47b66b`.

D0a BAKE EVIDENCE (the measurement that defines this worklist):
- graph_blob coverage = 62.9% (617787/982645); by-producer = {mesh_graph_explains: 617787} ONLY.
- ui_related_mesh coverage = 0.0% (0 / all served edges).
- blob = 115269 KB (+~16.6% vs pre-D0 ~98899 KB).

---

## (a) #5 FUSION FIELD PRESERVATION REPORT (Repository Truth)

Trace: `rust/stream-aggregator/src/fusion.rs` (`fuse_shard`) -> `rust/stream-aggregator/src/project.rs`
(`project_entity_for_fusion`) ; JS fallback `scripts/factory/lib/fuse-shard-js.js` ->
`registry-loader.js` `projectEntity`. The fusion stage operates on the ENTITY object (`entity.relations`
= the raw adapter relation objects), NOT on `graph.edges`. The graph-blob carrier (slot[3]/edge_id) is
built in the LATER relations+mesh stages, so fusion's relevance to D0 is: does it PRESERVE the entity's
relation objects + the mesh sinks so the downstream baker/distiller can attach the carrier.

Per-field IN/OUT table for ALL edge-carrier-relevant fields through `project_entity_for_fusion`
(project.rs:218-264, mechanism: `for key in PASSTHROUGH { base[key] = e.get(key).clone() }`):

| Field                | IN (at fusion input)      | OUT (survives projection)            | Verdict |
|----------------------|---------------------------|--------------------------------------|---------|
| `relations`          | YES (raw adapter objects) | YES (PASSTHROUGH project.rs:222)     | KEPT    |
| `mesh_profile`       | NO (attached AFTER fusion)| YES if present (PASSTHROUGH :237)    | KEPT    |
| `ui_related_mesh`    | NO (distiller writes it)  | YES if present (PASSTHROUGH :233)    | KEPT    |
| `source_trail_refs`  | n/a on entity (lives on graph.edges, not entity.relations) | n/a | N/A  |
| `edge_id`            | n/a on entity (graph.edges only)                           | n/a | N/A  |
| `target_type`        | per relation object       | KEPT (whole `relations` cloned)      | KEPT    |
| `confidence`         | per relation object       | KEPT (whole `relations` cloned)      | KEPT    |
| `target_id`          | per relation object       | KEPT + closed-world FILTERED         | KEPT*   |
| `base_model`/`datasets`/`arxiv_refs`/... (relation SOURCE fields) | YES | KEPT (PASSTHROUGH :230,:248-256) + relation-stage projection (project.rs:150-161) | KEPT |

`*` Closed-world filter (fusion.rs:100-112 Rust; fuse-shard-js.js:29-34 JS) `retain`s relation objects
whose `target_id` is a valid id; it MUTATES IN PLACE (`as_array_mut` + `retain`), so every surviving
relation object keeps ALL its fields. It does NOT touch slot[3]/edge_id (those are not on entity
relations).

VERDICT: **Fusion does NOT strip the carrier.** `relations`, `mesh_profile`, `ui_related_mesh` all
survive `project_entity_for_fusion` (and the JS `projectEntity` fallback passes the entity through
similarly). So the ui_related_mesh 0% is NOT a fusion-strip bug. (This folds into the Backend Authority
Map: the V27.61 anti-strip rule already guards this whitelist; `relations`/`mesh_profile`/
`ui_related_mesh` are all in PASSTHROUGH.) The ONE fusion subtlety that matters for #2 is that fusion
preserves `entity.relations` (the RAW, carrier-LESS adapter relations) intact -- and that is exactly the
array the distiller PREFERS over the baked carrier-bearing one (see (c)).

---

## (b) #1 DIAGNOSIS -- why do rel() typed producers' trails NOT reach graph_blob (only EXPLAINS)?

CLAIM under test (spec STEP 0b): "do the rel() producers actually EMIT a trail today, or did D0a only
wire the mesh-stage EXPLAINS mint?"

FINDING 1 -- the in-rel() producers DO emit a trail, in code, today. Verified empirically:
`relation-extractors.js:60-64` -> every `rel()` stamps `_evidence = evidenceElement({... method:
methodForVerb(verb), producer:'rel_extractor', source_url})`; `relations-generator.js:118` passes
`rel._evidence` to `addEdge`; `addEdge` (relations-generator.js:41-43) interns it (`ed.add(evidence)`)
and stores the COMPACT ref on slot[3]. A local run of `extractEntityRelations` confirmed BASED_ON/CITES/
EVALUATED_ON/STACK each carry a valid `_evidence` (method+producer+weight+source_url). So D0a did NOT
"only wire EXPLAINS"; the typed emission is wired.

FINDING 2 -- in code, the typed refs SURVIVE to the merged mesh dict and RESOLVE. A local simulation of
addEdge -> mesh `newEvidenceDict(ed.dict)` re-seed -> `assertEdgeTrail(slot[3], mergedDict)` returned
`ok:true` for BASED_ON/CITES. The Rust mesh import (`mesh_graph.rs:150-168`) does `edge.clone()` which
preserves slot[3]; the re-seed (`evidence.rs from_value`, mesh_graph.rs:136-137) interns seed strings/
urls/elements in first-seen order so indices are preserved (pinned by the D0a unit test
`dict re-seed ... rebuilds identical indices`).

THE SMOKING GUN -- FEATURED_IN is ALSO 0 in the bake. FEATURED_IN is minted in the SAME mesh stage,
into the SAME `ev` builder, by the SAME `add_sentinel` mechanism as EXPLAINS (mesh_graph.rs:245 vs :207),
yet by-producer shows ONLY `mesh_graph_explains` (no `mesh_graph_featured_in`). EXPLAINS (refs minted
FRESH into the LIVE mesh builder) is the ONLY thing that resolved. Everything that depends on an
IMPORTED ref (typed edges' refs into the re-seeded relations dict) resolved to NOTHING. Conclusion: in
the production bake the **re-seeded relations-stage dict was effectively EMPTY / not carried**, so
imported typed-edge refs ([0],[1],...) had no backing elements, while mesh-minted EXPLAINS refs
(appended live) did. (FEATURED_IN being 0 is consistent with either an empty reports input that cycle OR
the same import-dependence; it does not contradict the diagnosis.)

ROOT CAUSE (file:line) -- the relations-stage -> mesh-stage dictionary transport has a SILENT-NULL path:
- Rust relations writer embeds the dict ONLY via `relations.rs:67-69`:
  `dict_path.and_then(|p| load_json_file(&p).ok()).unwrap_or(Value::Null)` -- ANY read failure (missing
  `_tmp-evidence-dict.json.zst`, decode error) silently yields `evidence_dict: null` in explicit.json.
- The mesh re-seed `EvidenceBuilder::from_value(explicit.get("evidence_dict"))` (mesh_graph.rs:136-137)
  treats a null/absent dict as an EMPTY builder (evidence.rs:53 `if let Some(d) = seed`). So imported
  typed refs point into an empty element table -> 0 coverage, while live-minted EXPLAINS sentinels
  populate indices 0..N and resolve.
- The dict round-trips JS -> file -> Rust (relations-generator.js:131-135 writes
  `_tmp-evidence-dict.json.zst`; rust-bridge passes `dictPath`; relations.rs:67 reads it). A single quiet
  failure anywhere in that hop zeroes ALL typed coverage with NO error.

So #1 is NOT "typed producers don't emit" (they do) -- it is "the typed refs depend on a SILENT,
fragile cross-stage dict transport, and when it degrades EVERY imported ref dangles." The D0b fix must
make the transport LOUD + self-consistent so typed coverage reaches ~100% reliably.

---

## (c) #2 DIAGNOSIS -- why is ui_related_mesh 0%?

Per-entity path end-to-end: entity (`e.relations` raw vs `e.mesh_profile.relations` baked) ->
v25-distiller.js distillEntity -> resolveMeshEdge -> `e.ui_related_mesh` -> entity-projection.ts:142
`relations.related`.

ROOT CAUSE (cause ii in the prompt's framing -- distiller writes no ref to the stored column):
`v25-distiller.js:206-207` -- the distiller PREFERS `e.relations` over `e.mesh_profile.relations`:
```
const relations = (Array.isArray(e.relations) && e.relations.length > 0)
    ? e.relations : (e.mesh_profile?.relations || []);
```
`e.relations` = the RAW adapter relation objects (carried through fusion's `relations` passthrough,
diagnosis (a)) which NEVER had a source_trail. The carrier-BEARING relations live ONLY on
`e.mesh_profile.relations` (built by mesh-profile-baker.js:129-143 forwarding slot[3]/edge_id). So
whenever `e.relations` is non-empty (the common case), the distiller reads carrier-less objects ->
`srcTrail = rel.source_trail || []` (v25-distiller.js:226) -> `[]` -> resolveMeshEdge gets an empty
source_trail (mesh-resolve-filter.js:65 only sets `node.source_trail` when the array is non-empty) ->
the stored `ui_related_mesh` node carries NO ref -> 0% coverage. Empirically confirmed by a local
simulation: with both sources present, the distiller picks `e.relations` whose source_trail is MISSING.

SECONDARY CAUSE (iii -- dict not reachable for the ui_related_mesh sink): EVEN when
`e.mesh_profile.relations` IS used (entities with empty `e.relations`), its refs index the BAKED dict
sidecar `profile-evidence-dict.json.zst` (mesh-profile-baker.js:176-177) which includes the reverse
sentinel; but the canary resolves ui_related_mesh against `graph.evidence_dict`
(verify-mesh-canary.js:120-130), NOT the baked sidecar. The D0a code comment at :123-125 already flags
this. So a baked ref could be present yet read as "uncovered" by the canary, and the served sink has no
dict at all in `site_metadata`.

NOT a fusion strip (diagnosis (a) rules that out). NOT resolveMeshEdge dropping a present ref (it
forwards it, mesh-resolve-filter.js:62-66). It is (ii) wrong source preference + (iii) split dictionaries.

---

## (d) FIX APPROACH (Rust+JS lockstep) + #3 decomposition plan

### #1 fix -- typed edges reach graph_blob ~100% (P0)
1. HARDEN the dict transport so a silent-null can never zero typed coverage:
   - relations.rs:67-69: when `dict_path` is provided but the load FAILS, `eprintln!` a loud warning
     AND continue (do not silently null). JS lockstep: relations-generator.js already writes the dict
     before the FFI call; add a post-FFI assertion that `explicit.evidence_dict.elements.length > 0`
     when relations were emitted (warn loudly otherwise). This converts the silent failure into an
     observable one and is the structural cause of typed=0.
2. GUARANTEE the in-rel typed emission is structurally present (it already is in code; add a
   producer-coverage unit test asserting every BASED_ON/TRAINED_ON/CITES/USES/EVALUATED_ON/FEATURES
   edge from `extractEntityRelations` carries a resolvable `_evidence`, so a future projection regression
   that strips a relation-source field is caught).
3. STRUCTURAL SENTINELS (spec sec 7) for the out-of-rel edges already exist (FEATURES/FOLLOWS in
   relations-generator.js:88-98; EXPLAINS/FEATURED_IN in mesh stage). Confirm reverse edges (below) and
   keep them.

### #2 fix -- ui_related_mesh circuit ~100% (P0)
1. v25-distiller.js:206-207: PREFER the carrier-bearing source. Change the selection so that when
   `e.mesh_profile.relations` exists AND carries source_trail refs, it is used (it is the same edge set,
   resolve-filtered identically), falling back to `e.relations` only when no baked profile exists. Net:
   the stored `ui_related_mesh` edge carries the baked slot[3] ref.
2. UNIFY the dictionary the served sink + canary read. Carry ONE dict so a ui_related_mesh ref resolves:
   re-seed the baker's `ed` from `graph.evidence_dict` (already done, mesh-profile-baker.js:44) and have
   the canary resolve ui_related_mesh against the BAKED dict when present (read
   `profile-evidence-dict.json.zst`), else `graph.evidence_dict`. This removes the (iii) split.
3. DUAL-SINK RECONCILIATION TABLE in verify-mesh-canary.js (still WARN): for BOTH sinks emit
   edge-count, coverage%, AND a per-producer breakdown (extend `reportSink` which already computes
   byProducer; add a reconciliation summary line comparing the two sinks).

### reverse edges (spec sec 6, P0) -- reference the forward edge_id
- mesh-profile-baker.js:47,150-154: today a reverse edge gets ONE shared minimal `reverse_of` sentinel
  ref. Upgrade `buildInverseAdjacency` (reverse-edge-projector.js:70-84) to carry the forward
  `edge_id` (+ forward `source_trail_refs`) alongside `[source, verb]`, and `projectReverseEdges` to
  emit a `reverse_of` element that points at the forward edge_id (never a new bare fact). The Rust
  `relations.rs` reverse map is DEAD (spec sec 4, confirmed mesh_graph.rs not reading it) -> do NOT
  thread Rust there; live reverse = JS only. Lockstep N/A for the dead Rust map.

### Rust+JS lockstep sites touched
- evidence carrier transport robustness: relations.rs (Rust) + relations-generator.js (JS).
- canary reconciliation + dual-dict resolve: verify-mesh-canary.js (JS only; the canary is JS).
- baker source preference / reverse forward-ref: v25-distiller.js + mesh-profile-baker.js +
  reverse-edge-projector.js (JS; the baker has no Rust twin).
- EXPLAINS/FEATURED_IN mint already lockstepped in D0a (mesh_graph.rs + mesh-graph-generator.js); no
  change needed there beyond confirming refs survive.

### #4 (P2) -- DO NOT FLIP the canary to FAIL in this PR. Leave WARN. The flip is a separate gated step
after a verification bake confirms both sinks ~100%.

### #3 decomposition plan (P1 -- investigate, may not block merge)
Decompose the +16.6% (115269 KB vs ~98899 KB) blob delta into: (1) evidence_dict size (elements table +
strings + interned source_urls + enum tables), (2) per-edge carrier bytes (slot[3] ref arrays + slot[4]
edge_id, ~16-hex per edge), (3) reverse-edge carrier, (4) other. Expectation under spec 2B: 617787
EXPLAINS sentinels DEDUP to ~1 dict element (identical sentinel) so the dict is tiny; the dominant cost
is the per-edge edge_id string (16 hex chars x ~982645 edges ~= 15.7 MB raw, pre-zstd) + the slot[3]
arrays. If the measured delta is consistent with edge_id + ref arrays (NOT fat inlined objects), the
+16.6% is LEGITIMATE carrier overhead and NO fix is forced (report numbers, do not over-fit). The
acceptance "SHOULD <= 10%" is non-blocking; a >10% delta driven by edge_id strings is a documented,
expected cost of the deterministic edge_id (spec sec 5), not a fat-object leak (spec 2B violation).

### Flagged for PM
- The #1 root cause (silent-null dict transport) means the typed-edge population already exists in code;
  D0b makes it ROBUST + observable rather than re-implementing emission. If PM wants a belt-and-braces
  guarantee, the producer-coverage unit test + the loud transport assertion are the gates.
- #3: if the verification bake shows the delta is edge_id-dominated and >10%, recommend accepting it
  (deterministic edge_id is a spec mandate) rather than dropping edge_id to hit the SHOULD gate.
