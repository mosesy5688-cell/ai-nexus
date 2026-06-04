use std::collections::HashMap;

/// Calculate global FNI percentile rankings.
/// Port of aggregator-utils.js calculateGlobalStats (lines 28-53).
///
/// Algorithm:
/// 1. Sort all scores descending
/// 2. Build score_to_rank (first occurrence index) and score_to_count
/// 3. For each entity: effective_rank = rank + (count - 1) / 2
///    percentile = max(1, round((1 - effective_rank / total) * 100))
pub fn calculate_rankings(scores: &[(String, f64)]) -> HashMap<String, u8> {
    let count = scores.len();
    if count == 0 {
        return HashMap::new();
    }

    // Sort scores descending
    let mut sorted_scores: Vec<f64> = scores.iter().map(|(_, s)| *s).collect();
    sorted_scores.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));

    // Build score_to_rank (first occurrence) and score_to_count
    let mut score_to_rank: HashMap<OrderedF64, usize> = HashMap::new();
    let mut score_to_count: HashMap<OrderedF64, usize> = HashMap::new();

    for (i, &s) in sorted_scores.iter().enumerate() {
        let key = OrderedF64(s);
        score_to_rank.entry(key).or_insert(i);
        *score_to_count.entry(key).or_insert(0) += 1;
    }

    // Calculate percentile for each entity
    let mut rankings = HashMap::with_capacity(count);
    for (id, score) in scores {
        let key = OrderedF64(*score);
        let rank = *score_to_rank.get(&key).unwrap_or(&0);
        let count_at_score = *score_to_count.get(&key).unwrap_or(&1);
        let effective_rank = rank as f64 + (count_at_score as f64 - 1.0) / 2.0;
        let percentile = ((1.0 - effective_rank / count as f64) * 100.0)
            .round()
            .max(1.0) as u8;
        rankings.insert(id.clone(), percentile);
    }

    rankings
}

/// Wrapper for f64 that implements Hash + Eq (for HashMap keys).
/// Uses bit-level comparison (NaN == NaN, -0.0 == 0.0 for our purposes).
#[derive(Clone, Copy)]
struct OrderedF64(f64);

impl std::hash::Hash for OrderedF64 {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.0.to_bits().hash(state);
    }
}

impl PartialEq for OrderedF64 {
    fn eq(&self, other: &Self) -> bool {
        self.0.to_bits() == other.0.to_bits()
    }
}

impl Eq for OrderedF64 {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_basic_ranking() {
        // Top-down percentile: highest score (descending rank 0) -> 100. For N
        // distinct scores, the entity at 0-based descending rank r gets
        // round((1 - r/N) * 100). With N=3: rank 0 -> 100, rank 1 -> round(66.67)
        // = 67, rank 2 -> round(33.33) = 33. This mirrors the production source
        // of truth aggregator-utils.js calculateGlobalStats (lines 28-53).
        let scores = vec![
            ("a".to_string(), 90.0),
            ("b".to_string(), 50.0),
            ("c".to_string(), 10.0),
        ];
        let rankings = calculate_rankings(&scores);
        assert_eq!(*rankings.get("a").unwrap(), 100); // top, rank 0
        assert_eq!(*rankings.get("b").unwrap(), 67); // middle, rank 1 -> round(66.67)
        assert_eq!(*rankings.get("c").unwrap(), 33); // bottom, rank 2 -> round(33.33)
    }

    #[test]
    fn test_tied_scores() {
        // Tied scores use midrank to abolish the old "tied for top 100%" bug
        // (JS V25.5 FIX): effective_rank = first_rank + (count_at_score - 1) / 2.
        // Here a=100 is rank 0 -> 100; b,c,d all share score 0 with first_rank=1
        // and count=3, so effective_rank = 1 + (3-1)/2 = 2 and the percentile is
        // round((1 - 2/4) * 100) = 50 -- the midpoint of their tied range for
        // this 4-entity input. The ties never saturate at top and are identical.
        let scores = vec![
            ("a".to_string(), 100.0),
            ("b".to_string(), 0.0),
            ("c".to_string(), 0.0),
            ("d".to_string(), 0.0),
        ];
        let rankings = calculate_rankings(&scores);
        assert_eq!(*rankings.get("a").unwrap(), 100);
        // b,c,d sit at the midrank of their tied range (50), well below the top
        // entity, and identical to each other (no "tied for top" saturation).
        let b = *rankings.get("b").unwrap();
        assert!(
            b < 100,
            "Tied zero-score must not saturate at top 100%, got {}",
            b
        );
        assert_eq!(b, 50, "Tied bottom group should land at midrank 50, got {}", b);
        assert_eq!(b, *rankings.get("c").unwrap());
        assert_eq!(b, *rankings.get("d").unwrap());
    }

    #[test]
    fn test_empty() {
        let rankings = calculate_rankings(&[]);
        assert!(rankings.is_empty());
    }

    #[test]
    fn test_single_entity() {
        let scores = vec![("only".to_string(), 42.0)];
        let rankings = calculate_rankings(&scores);
        assert_eq!(*rankings.get("only").unwrap(), 100);
    }
}
