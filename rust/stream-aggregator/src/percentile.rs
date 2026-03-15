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
        let scores = vec![
            ("a".to_string(), 90.0),
            ("b".to_string(), 50.0),
            ("c".to_string(), 10.0),
        ];
        let rankings = calculate_rankings(&scores);
        assert_eq!(*rankings.get("a").unwrap(), 100); // top
        assert_eq!(*rankings.get("b").unwrap(), 50); // middle
        assert_eq!(*rankings.get("c").unwrap(), 17); // bottom
    }

    #[test]
    fn test_tied_scores() {
        // 3 entities with score 0 should all get low percentile, not top 100%
        let scores = vec![
            ("a".to_string(), 100.0),
            ("b".to_string(), 0.0),
            ("c".to_string(), 0.0),
            ("d".to_string(), 0.0),
        ];
        let rankings = calculate_rankings(&scores);
        assert_eq!(*rankings.get("a").unwrap(), 100);
        // b,c,d should all be ~25th percentile (tied at bottom)
        let b = *rankings.get("b").unwrap();
        assert!(
            b < 50,
            "Tied zero-score should be below 50th percentile, got {}",
            b
        );
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
