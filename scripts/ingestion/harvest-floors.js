/**
 * Known-Large-Source Harvest Floor Gate (PR-H2a, fail-loud)
 *
 * WHY: harvest-single.js only fails loud when an adapter sets result.error
 * (today only arxiv-adapter throws FetchError). Every HuggingFace adapter
 * catch-and-returns an empty array, so a real outage launders into a green
 * zero-yield run — invisible downstream because the GLOBAL merge floor
 * (ENTITY_BASELINE_FLOOR in merge-batches.js) passes on the aggregate while a
 * single known-large source silently contributes 0.
 *
 * This gate lives ABOVE the adapters: for sources we KNOW are large, a harvest
 * that completes WITHOUT an adapter error but yields below a conservative floor
 * is treated as a near-zero failure with no valid-zero proof, and must redden
 * the job. Sources absent from the map are unaffected (small-source tolerance,
 * Founder-decided).
 *
 * Floors are env-overridable (mirrors the ENTITY_BASELINE_FLOOR env pattern)
 * with in-code defaults at ~10% of each source's observed HEALTHY minimum, so
 * the gate fires on zero/near-zero but never on a merely-light-but-real day.
 *
 * KEYING REALITY: factory-harvest.yml invokes harvest-single.js exactly ONCE
 * per source (no per-shard/per-category fan-out), so per-invocation count ==
 * whole-source count. Floors are therefore whole-source.
 */

// Default floors keyed by the `sourceName` harvest-single is invoked with.
// Rationale (observed healthy minimum -> ~10% floor):
//   arxiv               54,401 healthy -> 5000
//   huggingface         ~70K+  healthy -> 7000
//   huggingface-papers  ~2K+   healthy -> 200
//   huggingface-datasets ~4K+  healthy -> 400
//   github              ~5K+   healthy -> 500
//   semanticscholar     ~3K    target  -> 300
const DEFAULT_FLOORS = {
    arxiv: 5000,
    huggingface: 7000,
    'huggingface-papers': 200,
    'huggingface-datasets': 400,
    github: 500,
    semanticscholar: 300,
};

/**
 * Resolve the effective floor for a source, honoring an env override.
 * Override env var: HARVEST_FLOOR_<SOURCE> with non-word chars upcased to `_`
 * (e.g. huggingface-papers -> HARVEST_FLOOR_HUGGINGFACE_PAPERS).
 * Returns null when the source is not a known-large source (gate inactive).
 *
 * @param {string} sourceName
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number|null}
 */
export function getSourceFloor(sourceName, env = process.env) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_FLOORS, sourceName)) {
        return null;
    }
    const envKey = `HARVEST_FLOOR_${sourceName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
    const raw = env[envKey];
    if (raw !== undefined && raw !== '') {
        const parsed = parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
    return DEFAULT_FLOORS[sourceName];
}

/**
 * Decide whether the floor gate should fire for a completed harvest.
 *
 * Fires ONLY when: the source is known-large (floor !== null), the adapter did
 * NOT already error loudly (hadAdapterError === false — no double-reporting),
 * and the final unique-entity count is below the floor.
 *
 * @param {Object} params
 * @param {string} params.sourceName
 * @param {number} params.count  final unique-entity count for this invocation
 * @param {boolean} params.hadAdapterError  true if the adapter already set an error
 * @param {NodeJS.ProcessEnv} [params.env]
 * @returns {{ violated: boolean, floor: number|null }}
 */
export function evaluateFloorGate({ sourceName, count, hadAdapterError, env = process.env }) {
    const floor = getSourceFloor(sourceName, env);
    if (floor === null || hadAdapterError) {
        return { violated: false, floor };
    }
    return { violated: count < floor, floor };
}

export { DEFAULT_FLOORS };
