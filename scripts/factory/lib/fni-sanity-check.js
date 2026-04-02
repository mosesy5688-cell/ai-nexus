/**
 * V2.0 FNI Sanity Check — Constitutional Circuit Breaker
 *
 * Validates FNI score distribution BEFORE artifacts leave the factory.
 * V2.0: Semantic factor S=50.0 default means baseline FNI ≈ 17.5+ for all entities.
 * Zero-FNI should be near-impossible unless the formula is broken.
 *
 * Runs post-finalize, pre-deploy. Failure = exit(1) = GHA build halts.
 */

const THRESHOLDS = {
    // V2.0: S=50.0 default means nearly all entities get FNI > 0.
    // Flag if > 5% are zero (indicates formula regression or broken S-factor)
    MAX_ZERO_RATIO: 0.05,
    // No single entity should exceed this (prevents runaway normalization)
    MAX_FNI_VALUE: 99.9,
    // V2.0: With S=50.0 base, median should be at least ~17 (0.35*50)
    MIN_MEDIAN_FNI: 10,
    // Minimum entities required for check to be meaningful
    MIN_ENTITY_COUNT: 1000,
};

/**
 * Run FNI distribution sanity checks against the PackAccumulator.
 * @param {PackAccumulator} accumulator - The SQLite-backed entity store
 * @returns {{ passed: boolean, report: object }}
 */
export function checkFniSanity(accumulator) {
    console.log('[FNI-CHECK] Running Constitutional Sanity Check...');

    const db = accumulator.db;
    if (!db) {
        console.warn('[FNI-CHECK] No accumulator DB available. Skipping.');
        return { passed: true, report: { skipped: true } };
    }

    const totalCount = db.prepare('SELECT count(*) as c FROM entities').get().c;
    if (totalCount < THRESHOLDS.MIN_ENTITY_COUNT) {
        console.log(`[FNI-CHECK] Only ${totalCount} entities (< ${THRESHOLDS.MIN_ENTITY_COUNT}). Skipping.`);
        return { passed: true, report: { skipped: true, count: totalCount } };
    }

    // Check 1: Zero-FNI ratio
    const zeroCount = db.prepare('SELECT count(*) as c FROM entities WHERE fni_score = 0 OR fni_score IS NULL').get().c;
    const zeroRatio = zeroCount / totalCount;

    // Check 2: Max FNI value
    const maxFni = db.prepare('SELECT max(fni_score) as m FROM entities').get().m || 0;

    // Check 3: Median FNI (approximate via percentile)
    const medianRow = db.prepare(
        'SELECT fni_score FROM entities ORDER BY fni_score LIMIT 1 OFFSET ?'
    ).get(Math.floor(totalCount / 2));
    const medianFni = medianRow?.fni_score || 0;

    // Check 4: Distribution spread (p10 vs p90)
    const p10Row = db.prepare(
        'SELECT fni_score FROM entities ORDER BY fni_score LIMIT 1 OFFSET ?'
    ).get(Math.floor(totalCount * 0.1));
    const p90Row = db.prepare(
        'SELECT fni_score FROM entities ORDER BY fni_score LIMIT 1 OFFSET ?'
    ).get(Math.floor(totalCount * 0.9));

    const report = {
        total: totalCount,
        zeroCount,
        zeroRatio: (zeroRatio * 100).toFixed(1) + '%',
        maxFni: maxFni.toFixed(1),
        medianFni: medianFni.toFixed(2),
        p10: (p10Row?.fni_score || 0).toFixed(2),
        p90: (p90Row?.fni_score || 0).toFixed(2),
        violations: [],
    };

    // Evaluate
    if (zeroRatio > THRESHOLDS.MAX_ZERO_RATIO) {
        report.violations.push(
            `ZERO_FLOOD: ${report.zeroRatio} of entities have FNI=0 (threshold: ${THRESHOLDS.MAX_ZERO_RATIO * 100}%)`
        );
    }

    if (maxFni > THRESHOLDS.MAX_FNI_VALUE) {
        report.violations.push(
            `RUNAWAY_FNI: Max FNI=${report.maxFni} exceeds ceiling ${THRESHOLDS.MAX_FNI_VALUE}`
        );
    }

    if (medianFni < THRESHOLDS.MIN_MEDIAN_FNI) {
        report.violations.push(
            `FLAT_DISTRIBUTION: Median FNI=${report.medianFni} below minimum ${THRESHOLDS.MIN_MEDIAN_FNI}`
        );
    }

    const passed = report.violations.length === 0;

    // Output
    console.log('[FNI-CHECK] Distribution Report:');
    console.log(`  Entities : ${report.total}`);
    console.log(`  Zero-FNI : ${report.zeroCount} (${report.zeroRatio})`);
    console.log(`  Max FNI  : ${report.maxFni}`);
    console.log(`  Median   : ${report.medianFni}`);
    console.log(`  P10/P90  : ${report.p10} / ${report.p90}`);

    if (passed) {
        console.log('[FNI-CHECK] PASSED. FNI distribution is healthy.');
    } else {
        console.error('\n[FNI-CHECK] CONSTITUTIONAL VIOLATION DETECTED:');
        for (const v of report.violations) {
            console.error(`  [VIOLATION] ${v}`);
        }
        console.error('[FNI-CHECK] Build artifacts are UNSAFE for production.');
        console.error('[FNI-CHECK] Investigate Ingest-stage FNI computation before retrying.\n');
    }

    return { passed, report };
}
