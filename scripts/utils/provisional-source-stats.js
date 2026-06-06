/**
 * Provisional Source Stats (observability-only)
 *
 * getNodeSource() in id-normalizer.js has three DEFAULT source returns that
 * silently INFER a source ('gh' / 'hf') when no real provenance is proven.
 * These fire per-edge at relation-extraction scale, so a non-HF base_model or
 * non-GH dependency can get a fabricated hf-/gh- prefix = false provenance.
 *
 * We are NOT correcting that behavior here (it would churn R7-frozen ids;
 * that is owned by the Identity Layer (2)). This module only makes the
 * fabrication OBSERVABLE: an aggregate counter keyed by {chosenDefault, type}
 * plus a small bounded reservoir of the raw id strings that hit each default,
 * with a single summary emitted at end-of-run by the relations driver.
 *
 * Zero behavior change: recordProvisionalSource() is a side-effect-only sink.
 * It NEVER alters getNodeSource's return value.
 */

const RESERVOIR_CAP = 50; // max sampled raw ids retained per {default,type} key

// key = `${chosenDefault}|${type}` -> { count, samples: string[] }
const _buckets = new Map();

/**
 * Record that getNodeSource fell through to a provisional default source.
 * Side-effect only - the caller still returns its own value unchanged.
 *
 * @param {string} chosenDefault  the inferred source ('gh' | 'hf')
 * @param {string} type           the node type passed to getNodeSource
 * @param {string} rawId          the raw id string that hit the default
 */
export function recordProvisionalSource(chosenDefault, type, rawId) {
    const key = `${chosenDefault}|${type || ''}`;
    let bucket = _buckets.get(key);
    if (!bucket) {
        bucket = { count: 0, samples: [] };
        _buckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.samples.length < RESERVOIR_CAP && typeof rawId === 'string') {
        bucket.samples.push(rawId);
    }
}

/**
 * Snapshot of provisional-default usage. Returns a plain serializable object:
 *   { total, byKey: { 'gh|tool': { count, sampleCount, samples: [...] }, ... } }
 * Intended to be logged once per run by the relations/aggregate driver.
 */
export function getProvisionalSourceStats() {
    let total = 0;
    const byKey = {};
    for (const [key, bucket] of _buckets) {
        total += bucket.count;
        byKey[key] = {
            count: bucket.count,
            sampleCount: bucket.samples.length,
            samples: bucket.samples.slice(),
        };
    }
    return { total, byKey };
}

/**
 * One-line-per-bucket summary emit. No-op when no default was ever taken, so
 * it never floods clean runs. Matches the existing console summary style used
 * by the relations generator.
 */
export function emitProvisionalSourceSummary(logger = console) {
    const stats = getProvisionalSourceStats();
    if (stats.total === 0) return;
    logger.warn(`  [PROVISIONAL_SOURCE] ${stats.total} edges used an inferred default source (not proven provenance - owned by Identity Layer 2):`);
    for (const [key, info] of Object.entries(stats.byKey)) {
        const sample = info.samples.slice(0, 3).join(', ');
        logger.warn(`    - ${key}: ${info.count} (e.g. ${sample})`);
    }
}

/** Test-only reset of the in-module aggregate. */
export function _resetProvisionalSourceStats() {
    _buckets.clear();
}

// CommonJS compatibility for legacy scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        recordProvisionalSource,
        getProvisionalSourceStats,
        emitProvisionalSourceSummary,
        _resetProvisionalSourceStats,
    };
}
