//! FNI V2.0 — Canonical Scoring Engine (Rust FFI)
//!
//! Formula: FNI = min(99.9, 0.35*S + 0.25*A + 0.15*P + 0.15*R + 0.10*Q) × staleness
//! Upgraded from V18.9 (Phase 6, 768-dim bge-base-en-v1.5)
//! Processes 10k entity batches via N-API Buffer protocol (Spec §5.1).

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};

// V2.0 Source Coefficients (Ks) — Spec §3.2
const KS_HF: f64 = 1.0;       // Model Forge (HuggingFace) - Baseline
const KS_GH: f64 = 5.0;       // Tool Source (GitHub)
const KS_ARXIV: f64 = 30.0;   // Knowledge Roots (ArXiv/S2)
const KS_DEFAULT: f64 = 0.2;  // Community Market

// V2.0 Decay Lambdas — Spec §3.2 R factor
const LAMBDA_FOUNDATIONAL: f64 = 0.002; // Models, Tools, Agents
const LAMBDA_STRUCTURAL: f64 = 0.005;   // Datasets, Collections, Papers
const LAMBDA_TEMPORAL: f64 = 0.025;     // Prompts, Spaces

// V25.8 Art 8.2: Staleness decay lambdas (harvest freshness)
const STALENESS_LAMBDA_DEFAULT: f64 = 0.005;
const STALENESS_LAMBDA_PAPER: f64 = 0.001;
const STALENESS_LAMBDA_PROMPT: f64 = 0.008;
const STALENESS_LAMBDA_DATASET: f64 = 0.003;

const LOG10_E: f64 = std::f64::consts::LOG10_E;
const NULL_TIME_DAYS: f64 = 365.0;
const DEFAULT_SEMANTIC_SCORE: f64 = 50.0;

#[derive(Deserialize)]
struct EntityInput {
    id: String,
    #[serde(default)]
    entity_type: String,
    #[serde(default)]
    raw_metrics: f64,
    #[serde(default)]
    completeness: f64,
    #[serde(default)]
    utility: f64,
    #[serde(default)]
    days_since_update: f64,
    #[serde(default)]
    date_valid: bool,
    #[serde(default)]
    mesh_points: f64,
    /// Optional semantic score override (default: 50.0)
    #[serde(default)]
    semantic_score: Option<f64>,
    /// Days since last harvest (_last_seen), for staleness decay
    #[serde(default)]
    days_since_harvest: Option<f64>,
}

#[derive(Serialize)]
#[napi(object)]
pub struct FniResult {
    pub id: String,
    pub fni_score: f64,
    pub raw_pop: f64,
    pub s: f64,
    pub a: f64,
    pub p: f64,
    pub r: f64,
    pub q: f64,
}

fn get_ks(id: &str) -> f64 {
    if id.starts_with("hf-") {
        KS_HF
    } else if id.starts_with("gh-") {
        KS_GH
    } else if id.starts_with("arxiv-") || id.starts_with("s2-") {
        KS_ARXIV
    } else {
        KS_DEFAULT
    }
}

fn get_decay_lambda(entity_type: &str) -> f64 {
    match entity_type {
        "model" | "tool" | "agent" => LAMBDA_FOUNDATIONAL,
        "dataset" | "collection" | "paper" => LAMBDA_STRUCTURAL,
        "prompt" | "space" => LAMBDA_TEMPORAL,
        _ => LAMBDA_STRUCTURAL,
    }
}

fn get_staleness_lambda(entity_type: &str) -> f64 {
    match entity_type {
        "paper" => STALENESS_LAMBDA_PAPER,
        "prompt" | "space" => STALENESS_LAMBDA_PROMPT,
        "dataset" | "collection" => STALENESS_LAMBDA_DATASET,
        _ => STALENESS_LAMBDA_DEFAULT,
    }
}

fn log10(x: f64) -> f64 {
    x.ln() * LOG10_E
}

fn compute_fni(e: &EntityInput) -> FniResult {
    let ks = get_ks(&e.id);
    let raw_pop = e.raw_metrics * ks;

    // S: Semantic (query-time ANN cosine similarity, factory default 50.0)
    let s = f64::min(99.9, e.semantic_score.unwrap_or(DEFAULT_SEMANTIC_SCORE));

    // P: Popularity (Asymptotic Log Compressor, base 8)
    let p = f64::min(99.9, 99.9 * (1.0 - f64::powf(10.0, -(log10(raw_pop + 1.0) / 8.0))));

    // R: Recency (Dynamic Exponential Decay)
    let lambda = get_decay_lambda(&e.entity_type);
    let days = if e.date_valid {
        f64::max(0.0, e.days_since_update)
    } else {
        NULL_TIME_DAYS
    };
    let r = f64::min(99.9, 100.0 * f64::exp(-lambda * days));

    // A: Authority (Asymptotic Gravity Field, base 4)
    let a = f64::min(99.9, 99.9 * (1.0 - f64::powf(10.0, -(log10(e.mesh_points + 1.0) / 4.0))));

    // Q: Quality (Completeness + Utility, normalized)
    let q = f64::min(99.9, (e.completeness + e.utility) / 2.0);

    // Master Formula V2.0: FNI = min(99.9, 0.35*S + 0.25*A + 0.15*P + 0.15*R + 0.10*Q)
    let base_fni = f64::min(99.9, (0.35 * s) + (0.25 * a) + (0.15 * p) + (0.15 * r) + (0.10 * q));

    // Staleness decay — penalize entities not recently harvested
    let staleness_factor = match e.days_since_harvest {
        Some(d) if d >= 1.0 => {
            let sl = get_staleness_lambda(&e.entity_type);
            f64::exp(-sl * d)
        }
        _ => 1.0, // No _last_seen or harvested today → no penalty
    };

    let fni = base_fni * staleness_factor;
    let rounded = (fni * 10.0).round() / 10.0;

    FniResult {
        id: e.id.clone(),
        fni_score: rounded,
        raw_pop: raw_pop.round(),
        s: (s * 10.0).round() / 10.0,
        a: (a * 10.0).round() / 10.0,
        p: (p * 10.0).round() / 10.0,
        r: (r * 10.0).round() / 10.0,
        q: (q * 10.0).round() / 10.0,
    }
}

/// Batch FNI calculation from JSON array buffer.
#[napi]
pub fn batch_calculate_fni(json_buffer: Buffer) -> Result<Vec<FniResult>> {
    let data = std::str::from_utf8(&json_buffer)
        .map_err(|e| Error::from_reason(format!("Invalid UTF-8: {}", e)))?;
    let entities: Vec<EntityInput> = serde_json::from_str(data)
        .map_err(|e| Error::from_reason(format!("JSON parse error: {}", e)))?;

    Ok(entities.iter().map(compute_fni).collect())
}

/// V26.5: Streaming FNI from shard directory — O(shard_size) memory.
#[napi]
pub fn batch_calculate_fni_from_dir(shard_dir: String, output_dir: String) -> Result<u32> {
    use std::io::{BufWriter, Write};

    let out_path = std::path::Path::new(&output_dir).join("fni-scores.json.zst");
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let file = std::fs::File::create(&out_path)
        .map_err(|e| Error::from_reason(format!("create output: {e}")))?;
    let mut encoder = zstd::Encoder::new(BufWriter::new(file), 3)
        .map_err(|e| Error::from_reason(format!("zstd init: {e}")))?;

    let mut count = 0u32;
    nxvf_core::for_each_shard(&shard_dir, |entities| {
        for e in &entities {
            if let Ok(input) = serde_json::from_value::<EntityInput>(e.clone()) {
                let result = compute_fni(&input);
                serde_json::to_writer(&mut encoder, &result)
                    .map_err(|e| format!("write: {e}"))?;
                encoder.write_all(b"\n").map_err(|e| format!("write: {e}"))?;
                count += 1;
            }
        }
        Ok(())
    })
    .map_err(|e| Error::from_reason(e))?;

    encoder.finish().map_err(|e| Error::from_reason(format!("zstd finish: {e}")))?;
    Ok(count)
}

/// Single entity FNI calculation.
#[napi]
pub fn calculate_fni_single(
    id: String,
    entity_type: String,
    raw_metrics: f64,
    completeness: f64,
    utility: f64,
    days_since_update: f64,
    date_valid: bool,
    mesh_points: f64,
) -> FniResult {
    compute_fni(&EntityInput {
        id,
        entity_type,
        raw_metrics,
        completeness,
        utility,
        days_since_update,
        date_valid,
        mesh_points,
        semantic_score: None,
        days_since_harvest: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fni_cap() {
        let result = compute_fni(&EntityInput {
            id: "hf-model--test".to_string(),
            entity_type: "model".to_string(),
            raw_metrics: 1e9,
            completeness: 100.0,
            utility: 100.0,
            days_since_update: 0.0,
            date_valid: true,
            mesh_points: 1e6,
            semantic_score: Some(99.0),
            days_since_harvest: None,
        });
        assert!(result.fni_score <= 99.9);
    }

    #[test]
    fn test_semantic_baseline() {
        let result = compute_fni(&EntityInput {
            id: "hf-model--test".to_string(),
            entity_type: "model".to_string(),
            raw_metrics: 0.0,
            completeness: 0.0,
            utility: 0.0,
            days_since_update: 0.0,
            date_valid: false,
            mesh_points: 0.0,
            semantic_score: None, // Should default to 50.0
            days_since_harvest: None,
        });
        // S=50, A=0, P=0, R=exp(-0.002*365)≈48, Q=0
        // baseFNI = 0.35*50 + 0.15*48 = 17.5 + 7.2 = 24.7
        assert!(result.fni_score > 17.0, "S=50 baseline should give FNI > 17, got {}", result.fni_score);
        assert!(result.s >= 49.0, "S should be ~50, got {}", result.s);
    }

    #[test]
    fn test_null_time_trap() {
        let result = compute_fni(&EntityInput {
            id: "hf-model--test".to_string(),
            entity_type: "model".to_string(),
            raw_metrics: 1000.0,
            completeness: 50.0,
            utility: 50.0,
            days_since_update: 0.0,
            date_valid: false,
            mesh_points: 0.0,
            semantic_score: None,
            days_since_harvest: None,
        });
        // With 365-day decay at lambda=0.002, R should be ~48
        assert!(result.r < 50.0);
    }

    #[test]
    fn test_arxiv_ks_boost() {
        let arxiv = compute_fni(&EntityInput {
            id: "arxiv-paper--test".to_string(),
            entity_type: "paper".to_string(),
            raw_metrics: 100.0,
            completeness: 50.0,
            utility: 30.0,
            days_since_update: 30.0,
            date_valid: true,
            mesh_points: 0.0,
            semantic_score: None,
            days_since_harvest: None,
        });
        let hf = compute_fni(&EntityInput {
            id: "hf-model--test".to_string(),
            entity_type: "model".to_string(),
            raw_metrics: 100.0,
            completeness: 50.0,
            utility: 30.0,
            days_since_update: 30.0,
            date_valid: true,
            mesh_points: 0.0,
            semantic_score: None,
            days_since_harvest: None,
        });
        assert!(arxiv.p > hf.p, "ArXiv Ks=30 should produce higher P");
    }
}
