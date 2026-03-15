//! V18.9 FNI Singularity Scoring Engine (Rust FFI)
//!
//! Master Formula: FNI = min(99.9, (Sp * 0.45) + (Sf * 0.30) + (Sm * 0.25))
//! Processes 10k entity batches via N-API Buffer protocol (Spec §5.1).

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};

// V18.9 Source Coefficients (Ks)
const KS_HF: f64 = 1.0;
const KS_GH: f64 = 5.0;
const KS_ARXIV: f64 = 30.0;
const KS_DEFAULT: f64 = 0.2;

// V18.9 Decay Lambdas
const LAMBDA_FOUNDATIONAL: f64 = 0.002; // Models, Tools, Agents
const LAMBDA_STRUCTURAL: f64 = 0.005;   // Datasets, Collections, Papers
const LAMBDA_TEMPORAL: f64 = 0.025;     // Prompts, Spaces

const LOG10_E: f64 = std::f64::consts::LOG10_E;
const NULL_TIME_DAYS: f64 = 365.0;

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
    mesh_points: f64,
    /// -1.0 signals missing date (apply 365-day penalty)
    #[serde(default)]
    date_valid: bool,
}

#[derive(Serialize)]
#[napi(object)]
pub struct FniResult {
    pub id: String,
    pub fni_score: f64,
    pub raw_pop: f64,
    pub sp: f64,
    pub sf: f64,
    pub sm: f64,
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

fn get_lambda(entity_type: &str) -> f64 {
    match entity_type {
        "model" | "tool" | "agent" => LAMBDA_FOUNDATIONAL,
        "dataset" | "collection" | "paper" => LAMBDA_STRUCTURAL,
        "prompt" | "space" => LAMBDA_TEMPORAL,
        _ => LAMBDA_STRUCTURAL,
    }
}

fn log10(x: f64) -> f64 {
    x.ln() * LOG10_E
}

fn compute_fni(e: &EntityInput) -> FniResult {
    let ks = get_ks(&e.id);
    let raw_pop = e.raw_metrics * ks;

    // Sp: Asymptotic Log Compressor (base 8) + Quality Correction
    let log_compressed = 99.9 * (1.0 - f64::powf(10.0, -(log10(raw_pop + 1.0) / 8.0)));
    let quality_factor = 1.0 + (e.completeness + e.utility) / 500.0;
    let sp_base = f64::min(99.9, log_compressed * quality_factor);

    // Sf: Dynamic Exponential Decay
    let lambda = get_lambda(&e.entity_type);
    let days = if e.date_valid {
        f64::max(0.0, e.days_since_update)
    } else {
        NULL_TIME_DAYS
    };
    let sf = 100.0 * f64::exp(-lambda * days);

    // Sp with freshness boost
    let sp = f64::min(99.9, sp_base * (1.0 + sf / 500.0));

    // Sm: Asymptotic Gravity Field (base 4)
    let sm = 99.9 * (1.0 - f64::powf(10.0, -(log10(e.mesh_points + 1.0) / 4.0)));

    // Master Formula
    let fni = f64::min(99.9, (sp * 0.45) + (sf * 0.30) + (sm * 0.25));
    let rounded = (fni * 10.0).round() / 10.0;

    FniResult {
        id: e.id.clone(),
        fni_score: rounded,
        raw_pop: raw_pop.round(),
        sp: (sp * 10.0).round() / 10.0,
        sf: (sf * 10.0).round() / 10.0,
        sm: (sm * 10.0).round() / 10.0,
    }
}

/// Batch FNI calculation from JSON array buffer.
/// Input: JSON array of EntityInput objects.
/// Returns: Vec<FniResult> in same order.
#[napi]
pub fn batch_calculate_fni(json_buffer: Buffer) -> Result<Vec<FniResult>> {
    let data = std::str::from_utf8(&json_buffer)
        .map_err(|e| Error::from_reason(format!("Invalid UTF-8: {}", e)))?;
    let entities: Vec<EntityInput> = serde_json::from_str(data)
        .map_err(|e| Error::from_reason(format!("JSON parse error: {}", e)))?;

    Ok(entities.iter().map(compute_fni).collect())
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
        });
        assert!(result.fni_score <= 99.9);
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
            date_valid: false, // Missing date
            mesh_points: 0.0,
        });
        // With 365-day decay at lambda=0.002, Sf should be ~48
        assert!(result.sf < 50.0);
    }

    #[test]
    fn test_arxiv_ks_boost() {
        let arxiv = compute_fni(&EntityInput {
            id: "arxiv-paper--test".to_string(),
            entity_type: "paper".to_string(),
            raw_metrics: 100.0, // 100 citations * 30 = 3000 rawPop
            completeness: 50.0,
            utility: 30.0,
            days_since_update: 30.0,
            date_valid: true,
            mesh_points: 0.0,
        });
        let hf = compute_fni(&EntityInput {
            id: "hf-model--test".to_string(),
            entity_type: "model".to_string(),
            raw_metrics: 100.0, // 100 * 1.0 = 100 rawPop
            completeness: 50.0,
            utility: 30.0,
            days_since_update: 30.0,
            date_valid: true,
            mesh_points: 0.0,
        });
        assert!(arxiv.sp > hf.sp, "ArXiv Ks=30 should produce higher Sp");
    }
}
