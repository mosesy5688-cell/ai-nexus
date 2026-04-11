/**
 * Shard Constants — Single Source of Truth
 *
 * V25.9.2: Consolidated after PR #1728 left the shard count hardcoded in three
 * separate files (pack-db.js, sqlite-engine.ts, CatalogDataSource.js). Any bump
 * now touches exactly one line here.
 *
 * META_SHARD_COUNT history:
 *   V5.8  →  16  (initial hash sharding)
 *   V25.9 →  40  (density growth)
 *   #1728 →  48  (post-#1727 slot_0 = 101.53 MB, ~1 month runway)
 *   now   →  96  (~10 month runway at current +13 MB/shard/month growth)
 *
 * Why this lives in src/constants/ as plain .js:
 *   - Node packer (scripts/factory/pack-db.js) needs it at build time → plain ESM
 *   - Astro SSR (src/lib/sqlite-engine.ts) imports it at SSR time → TS-compatible
 *   - Client bundle (src/scripts/lib/CatalogDataSource.js) imports it → Vite bundles it
 *   A .ts file would block the Node packer (no native TS execution).
 *
 * The manifest (data/shards_manifest.json) is still the runtime source of truth;
 * these constants only apply when the manifest fetch fails.
 */

export const META_SHARD_COUNT = 96;
