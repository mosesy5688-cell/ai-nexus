//! Knowledge Linker V25.8
//! Links entities to knowledge articles via keyword matching.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::Value;
use std::collections::HashMap;

#[napi(object)]
pub struct KnowledgeLinkerResult {
    pub output_data: Buffer,
    pub total_links: u32,
    pub inverse_hubs: u32,
}

/// All 64 keyword -> slug mappings from knowledge-linker.js
const KNOWLEDGE_KEYWORDS: &[(&str, &str)] = &[
    // Scoring & Metrics
    ("fni", "fni-score"),
    ("fni_score", "fni-score"),
    ("fni-score", "fni-score"),
    ("humaneval", "humaneval-benchmark"),
    ("mmlu", "mmlu-benchmark"),
    ("gsm8k", "gsm8k-benchmark"),
    ("hellaswag", "commonsense-reasoning"),
    // Model Architecture
    ("transformer", "transformer-architecture"),
    ("attention", "attention-mechanism"),
    ("moe", "mixture-of-experts"),
    ("mixture of experts", "mixture-of-experts"),
    ("context length", "context-length"),
    ("context window", "context-length"),
    ("context_length", "context-length"),
    // Quantization & Formats
    ("gguf", "gguf-format"),
    ("ggml", "gguf-format"),
    ("gptq", "quantization"),
    ("awq", "quantization"),
    ("bnb", "quantization"),
    ("bitsandbytes", "quantization"),
    ("int4", "quantization"),
    ("int8", "quantization"),
    ("fp16", "precision"),
    ("bf16", "precision"),
    // Fine-tuning
    ("lora", "lora-finetuning"),
    ("qlora", "lora-finetuning"),
    ("peft", "lora-finetuning"),
    ("finetuned", "fine-tuning"),
    ("fine-tuned", "fine-tuning"),
    ("instruct", "instruction-tuning"),
    ("chat", "chat-models"),
    // Inference
    ("vllm", "inference-optimization"),
    ("tgi", "inference-optimization"),
    ("ollama", "local-deployment"),
    ("llama.cpp", "local-deployment"),
    // Safety
    ("rlhf", "rlhf"),
    ("dpo", "direct-preference-optimization"),
    ("alignment", "ai-alignment"),
    // Multimodal
    ("multimodal", "multimodal"),
    ("vision", "vision-models"),
    ("image", "image-generation"),
    ("audio", "audio-models"),
    ("speech", "speech-models"),
    // RAG & Embeddings
    ("embedding", "embeddings"),
    ("embeddings", "embeddings"),
    ("rag", "rag-retrieval"),
    ("retrieval", "rag-retrieval"),
    ("vector", "vector-databases"),
];

fn str_val(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn count_occurrences(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() { return 0; }
    haystack.matches(needle).count()
}

fn extract_knowledge_links(entity: &Value) -> Vec<(String, i64)> {
    let mut links: HashMap<String, f64> = HashMap::new();

    // Build searchable text
    let mut parts = vec![
        str_val(entity, "name"),
        str_val(entity, "description"),
        str_val(entity, "architecture"),
        str_val(entity, "pipeline_tag"),
        str_val(entity, "primary_category"),
    ];
    if let Some(tags) = entity.get("tags").and_then(|t| t.as_array()) {
        for tag in tags {
            if let Some(s) = tag.as_str() {
                parts.push(s.to_string());
            }
        }
    }
    let search_text = parts.join(" ").to_lowercase();

    for &(keyword, slug) in KNOWLEDGE_KEYWORDS {
        let kw_lower = keyword.to_lowercase();
        if search_text.contains(&kw_lower) {
            let count = count_occurrences(&search_text, &kw_lower);
            let confidence = f64::min(1.0, 0.5 + count as f64 * 0.1);
            let entry = links.entry(slug.to_string()).or_insert(0.0);
            if confidence > *entry {
                *entry = confidence;
            }
        }
    }

    links.into_iter()
        .map(|(slug, conf)| (slug, (conf * 100.0).round() as i64))
        .collect()
}

/// V26.5: Compute knowledge links by streaming shard files — O(shard_size) memory.
#[napi]
pub fn compute_knowledge_links_from_dir(shard_dir: String, _output_dir: String) -> Result<KnowledgeLinkerResult> {
    // Accumulate only the lightweight link results, not the full entities
    let mut all_links: Vec<Value> = Vec::new();
    let mut stats: HashMap<String, u32> = HashMap::new();

    let total = nxvf_core::for_each_shard(&shard_dir, |entities| {
        for entity in &entities {
            let id = str_val(entity, "id");
            let etype = {
                let t = str_val(entity, "type");
                if t.is_empty() { "model".to_string() } else { t }
            };
            let links = extract_knowledge_links(entity);
            if links.is_empty() { continue; }

            let knowledge: Vec<Value> = links.iter().map(|(slug, conf)| {
                *stats.entry(slug.clone()).or_insert(0) += 1;
                serde_json::json!({ "slug": slug, "confidence": conf })
            }).collect();

            all_links.push(serde_json::json!({
                "entity_id": id, "entity_type": etype, "knowledge": knowledge,
            }));
        }
        Ok(())
    }).map_err(|e| Error::from_reason(e))?;

    eprintln!("[RUST-SAT] compute_knowledge_links_from_dir: streamed {} entities, {} links", total, all_links.len());
    build_knowledge_output(all_links, stats)
}

/// Link entities to knowledge articles via keyword matching (legacy Buffer API).
#[napi]
pub fn compute_knowledge_links(entities_json: Buffer) -> Result<KnowledgeLinkerResult> {
    let raw = String::from_utf8_lossy(&entities_json);
    let sanitized = nxvf_core::sanitize_json_escapes(&raw);
    let entities: Vec<Value> = serde_json::from_str(&sanitized)
        .map_err(|e| Error::from_reason(format!("JSON parse error: {}", e)))?;
    compute_knowledge_links_inner(&entities)
}

fn compute_knowledge_links_inner(entities: &[Value]) -> Result<KnowledgeLinkerResult> {
    let mut all_links: Vec<Value> = Vec::new();
    let mut stats: HashMap<String, u32> = HashMap::new();

    for entity in entities {
        let id = str_val(entity, "id");
        let etype = {
            let t = str_val(entity, "type");
            if t.is_empty() { "model".to_string() } else { t }
        };
        let links = extract_knowledge_links(entity);
        if links.is_empty() { continue; }

        let knowledge: Vec<Value> = links.iter().map(|(slug, conf)| {
            *stats.entry(slug.clone()).or_insert(0) += 1;
            serde_json::json!({ "slug": slug, "confidence": conf })
        }).collect();

        all_links.push(serde_json::json!({
            "entity_id": id, "entity_type": etype, "knowledge": knowledge,
        }));
    }
    build_knowledge_output(all_links, stats)
}

fn build_knowledge_output(all_links: Vec<Value>, stats: HashMap<String, u32>) -> Result<KnowledgeLinkerResult> {
    // Build inverse links (max 20 per knowledge node, sorted by confidence desc)
    let mut inverse: HashMap<String, Vec<Value>> = HashMap::new();
    for link in &all_links {
        let eid = link["entity_id"].as_str().unwrap_or("");
        let etype = link["entity_type"].as_str().unwrap_or("");
        if let Some(knowledge) = link["knowledge"].as_array() {
            for k in knowledge {
                let slug = k["slug"].as_str().unwrap_or("");
                let conf = k["confidence"].as_i64().unwrap_or(0);
                let entries = inverse.entry(slug.to_string()).or_default();
                if entries.len() < 20 {
                    entries.push(serde_json::json!({
                        "entity_id": eid, "entity_type": etype, "confidence": conf,
                    }));
                }
            }
        }
    }
    for entries in inverse.values_mut() {
        entries.sort_by(|a, b| {
            b["confidence"].as_i64().unwrap_or(0).cmp(&a["confidence"].as_i64().unwrap_or(0))
        });
    }

    let inverse_hubs = inverse.len() as u32;
    let total_links = all_links.len() as u32;
    let output = serde_json::json!({
        "_v": "25.8", "_ts": "auto", "_count": total_links,
        "_keywords": KNOWLEDGE_KEYWORDS.len(),
        "stats": stats, "links": all_links, "inverseLinks": inverse,
    });

    let json_bytes = serde_json::to_vec(&output)
        .map_err(|e| Error::from_reason(format!("Serialize error: {}", e)))?;
    let compressed = zstd::encode_all(json_bytes.as_slice(), 3)
        .map_err(|e| Error::from_reason(format!("Zstd compress error: {}", e)))?;

    Ok(KnowledgeLinkerResult { output_data: compressed.into(), total_links, inverse_hubs })
}
