//! Bake-gating canaries for the cluster pass (gates 2/3/4 enforcement helpers).
//!
//! These are STRUCTURAL fail-the-bake checks, never prose. Each returns a
//! machine-checkable verdict the NAPI surface lifts into the bake summary so a
//! violation aborts the bake (mirrors verify-canaries.js discipline) instead of
//! emitting untrustworthy clusters.

/// GATE 3 (partition-size canary): detect edge skew across hash-partitions. A
/// single partition holding a disproportionate share of edge rows means the hash
/// is degenerate (or one mega-component dominates) — the resident-partition
/// memory bound O(N/K) no longer holds, so clusters are untrustworthy. Returns
/// Err (fail the bake) when the worst partition exceeds `max_share` of all rows.
///
/// `max_share` in (0,1]: e.g. 0.50 fails a partition holding >50% of edge rows
/// while >~1/K is expected. We also require a floor of total rows so a tiny
/// fixture (where one of two rows is trivially 50%) does not false-positive.
pub fn check_partition_skew(counts: &[u64], max_share: f64, min_total: u64) -> Result<(), String> {
    let total: u64 = counts.iter().sum();
    if total < min_total {
        return Ok(()); // too few rows for skew to be meaningful
    }
    let worst = counts.iter().copied().max().unwrap_or(0);
    let share = worst as f64 / total as f64;
    if share > max_share {
        let idx = counts.iter().position(|&c| c == worst).unwrap_or(0);
        return Err(format!(
            "PARTITION_SKEW: partition {} holds {}/{} edge rows ({:.1}% > {:.1}% cap). \
             Edge skew breaks the O(N/K) resident bound — failing the bake rather than \
             emitting untrustworthy clusters.",
            idx, worst, total, share * 100.0, max_share * 100.0
        ));
    }
    Ok(())
}

/// GATE 4 support: the largest single-partition resident node count. Peak
/// label-map RSS scales with THIS, which is ~N/K (NOT N) — the slope-gate asserts
/// it falls as K rises. Computed from per-partition node counts (cheap, no map).
pub fn max_partition_nodes(node_counts: &[u64]) -> u64 {
    node_counts.iter().copied().max().unwrap_or(0)
}

/// Cluster-health floor (mirrors the IDGR non-singleton floor, §F): a SAME_AS
/// graph that produced ZERO non-singleton clusters means SAME_AS never fired —
/// the mesh zero-rel failure class. When `expect_non_singletons` is set and none
/// exist, fail the bake. (When the real corpus legitimately has no xrefs this is
/// disabled; the fixture path asserts it.)
pub fn check_non_singleton_floor(
    non_singleton_clusters: u64,
    expect_non_singletons: bool,
) -> Result<(), String> {
    if expect_non_singletons && non_singleton_clusters == 0 {
        return Err(
            "NON_SINGLETON_FLOOR: 0 multi-member clusters — SAME_AS never folded any pair. \
             This is the mesh zero-rel failure class; failing the bake."
                .into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skew_fails_when_one_partition_dominates() {
        // 90 rows in p0, 10 spread elsewhere -> 90% share > 50% cap -> fail.
        let counts = vec![90, 5, 5];
        assert!(check_partition_skew(&counts, 0.50, 10).is_err());
    }

    #[test]
    fn skew_ok_when_balanced() {
        let counts = vec![34, 33, 33];
        assert!(check_partition_skew(&counts, 0.50, 10).is_ok());
    }

    #[test]
    fn skew_ignores_tiny_fixtures() {
        // 1 + 1 rows: 50% share but below min_total -> not meaningful, pass.
        let counts = vec![1, 1];
        assert!(check_partition_skew(&counts, 0.50, 10).is_ok());
    }

    #[test]
    fn non_singleton_floor_enforced() {
        assert!(check_non_singleton_floor(0, true).is_err());
        assert!(check_non_singleton_floor(3, true).is_ok());
        assert!(check_non_singleton_floor(0, false).is_ok());
    }
}
