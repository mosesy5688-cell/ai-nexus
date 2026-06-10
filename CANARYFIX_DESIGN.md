# CANARYFIX_DESIGN — D0b ui_related_mesh source_trail canary MEASUREMENT fix

Branch: `fix/d0b-canary-sidecar-load` (off main b17d0bcd). Scope-locked to
`scripts/factory/lib/verify-mesh-canary.js` (+ a unit test). WARN-only stays WARN-only.

## What is being fixed (MEASUREMENT, not DATA)

The served `ui_related_mesh` DATA is already correct: every served node carries a
compact `source_trail` (+ `edge_id`). Forward (rel_extractor) refs are LOW indices
that exist in the graph `evidence_dict`. REVERSE-edge refs (reverse_of:
CITED_BY/EVALUATED_BY/BASIS_OF/DEFINES/...) are HIGH indices (~553,563+) that exist
ONLY in the baked sidecar `output/cache/mesh/profile-evidence-dict.json.zst` — the
SUPERSET dict the baker appends reverse elements to (mesh-profile-baker.js:44-58,
183-189).

The canary resolves `ui_related_mesh` against `bakedDict = loadBakedDict(cacheDir) ||
graphDict` (verify-mesh-canary.js:161). When `loadBakedDict` returns null it silently
falls back to `graphDict`, where the reverse HIGH indices do not exist -> every reverse
ref reports `unresolvable-ref` -> a FABRICATED ~25% coverage gap. The data is fine; the
measurement is broken.

## CONFIRMED root cause: the sync decompress codec is unavailable in the verify env (CODEC, not path)

`loadBakedDict` (verify-mesh-canary.js:129-138) builds the correct path
(`<cacheDir>/mesh/profile-evidence-dict.json.zst`) and `fs.existsSync` gates it; RF#2
(#2169) already added the sidecar to cache-save/restore so the FILE is present. The path
is NOT the problem.

`loadBakedDict` decompresses via `zstdSync` (verify-mesh-canary.js:24-35), which probes
ONLY the Rust FFI native addon
(`rust/stream-aggregator/stream-aggregator-rust.node`) and, when that addon is not
loadable, returns null. `verify-db.js` runs FULLY SYNCHRONOUSLY (no async main / no
top-level await), so the canary must decompress synchronously.

Reproduced in this env: the Rust `.node` addon is **MISSING** (createRequire throws ->
`_zstdRust = null` -> `zstdSync` returns null -> `loadBakedDict` returns null -> silent
graphDict fallback). The `zstd` CLI binary, however, **IS present** (v1.5.7). This is the
exact failure shape on the GHA verify runner: the Rust addon is not built/loadable there,
but `ubuntu-latest` ships the `zstd` CLI.

### Why the canary's codec is too narrow vs. the codec that DOES work

`scripts/factory/lib/zstd-helper.js` (`zstdDecompress`) — the path the BAKER itself uses
to write the sidecar — has a 3-TIER fallback: Rust FFI -> native `zstd` CLI
(`zstd-native.js`) -> WASM. The canary only implements TIER 1. `zstd-native.js` already
exposes a SYNC CLI decompressor, `tryNativeDecompressSync(buffer)` (spawnSync('zstd',
['-d','-q'])), which is sync-safe and works wherever the OS `zstd` binary exists (GHA
runners + this env). That is the missing tier.

## Chosen fix

1. `zstdSync` gains a TIER-2 fallback: after the Rust FFI miss, try
   `tryNativeDecompressSync` from `./zstd-native.js`. (WASM tier-3 is async-only and not
   needed: the CLI covers the verify env. We do NOT add a flaky async path into a sync
   canary.)
2. `loadBakedDict` distinguishes sidecar-ABSENT (file not present — quiet, defined
   fallback) from sidecar-LOAD-FAILED (file present but read/decompress/parse failed — a
   LOUD `console.warn`, no silent graphDict fabrication). `verifySourceTrailCoverage`
   emits a LOUD warn when the sidecar was expected (ui_related_mesh has refs) but could
   not be loaded, then states reverse refs will mis-report — instead of silently
   producing a fake gap.
3. `reportSink` adds `gapByType` (relation verb) + `gapByReason` (the `assertEdgeTrail`
   reason PREFIX: no-refs | no-dict | unresolvable-ref | bad-method | bad-producer |
   empty-source_field) tallies on the gap branch, printed per-sink and in
   `printReconciliation`.
4. Canary STAYS WARN-only: no `process.exit(1)`, no `check()` flip on coverage. The
   WARN->FAIL flip is a separate later PR.
5. Fixtures cover: (a) sidecar-MISSING -> loud warn + defined fallback; (b)
   sidecar-LOADED -> reverse HIGH-index refs RESOLVE -> ~100% coverage; (c) a reverse
   HIGH-index ref (index >> graph-dict length) resolves against the loaded sidecar.

## Explicitly DEFERRED (NOT this PR)

reverse_of-via-forward-edge_id resolution (option 2); any producer / pack-db / baker /
distiller / Rust / data change; flipping the canary to FAIL.
