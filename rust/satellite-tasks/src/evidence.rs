//! D0 source_trail evidence carrier (Rust side) -- the LOCKSTEP mirror of
//! scripts/factory/lib/evidence-carrier.js. The mesh stage imports the
//! relations-stage `evidence_dict`, then APPENDS structural sentinel elements for
//! the out-of-rel edges it mints (EXPLAINS / FEATURED_IN), returning COMPACT
//! integer refs (spec 2B) -- never an inlined element object on an edge.
//!
//! Enum ORDINALS (producers/methods) are FROZEN constants identical to the JS
//! enum order so a ref minted in Rust resolves the same as one minted in JS.
//! Interning is first-seen append order over the SAME input order -> identical
//! dicts (parity-locked by the unit suite).

use serde_json::{json, Value};
use std::collections::HashMap;

// FROZEN -- identical order to evidence-carrier.js PRODUCERS.
pub const PRODUCERS: [&str; 6] = [
    "relations_generator", "rel_extractor", "mesh_graph_explains",
    "mesh_graph_featured_in", "reverse_edge_projector", "report_injection",
];
// FROZEN -- identical order to evidence-carrier.js METHODS.
pub const METHODS: [&str; 11] = [
    "exact_source_url_xref", "derived_from_xref", "cites_xref", "uses_xref",
    "shared_source_url_unverified", "declared_dependency", "leaderboard_membership",
    "keyword_mention", "reverse_of", "structural_injection", "report_chain",
];
// FROZEN weights -- identical to assertion-weights.js METHOD_WEIGHTS (by method).
pub const WEIGHTS: [f64; 11] = [
    1.0, 0.5, 0.3, 0.3, 0.4, 0.5, 0.5, 0.3, 0.0, 0.1, 0.1,
];

fn producer_ord(p: &str) -> Option<usize> { PRODUCERS.iter().position(|&x| x == p) }
fn method_ord(m: &str) -> Option<usize> { METHODS.iter().position(|&x| x == m) }

/// Mutable view over an evidence_dict Value, with intern indices for fast append.
pub struct EvidenceBuilder {
    strings: Vec<String>,
    string_ord: HashMap<String, usize>,
    urls: Vec<String>,
    url_ord: HashMap<String, usize>,
    elements: Vec<Value>,
    elem_ord: HashMap<String, usize>,
}

impl EvidenceBuilder {
    /// Re-seed from an imported dict (the relations-stage explicit.evidence_dict).
    /// A null/absent dict yields an empty builder (pre-D0a relations file).
    pub fn from_value(seed: Option<&Value>) -> Self {
        let mut b = EvidenceBuilder {
            strings: Vec::new(), string_ord: HashMap::new(),
            urls: Vec::new(), url_ord: HashMap::new(),
            elements: Vec::new(), elem_ord: HashMap::new(),
        };
        if let Some(d) = seed {
            if let Some(arr) = d.get("strings").and_then(|v| v.as_array()) {
                for s in arr { if let Some(s) = s.as_str() { b.intern_str(s); } }
            }
            if let Some(arr) = d.get("source_urls").and_then(|v| v.as_array()) {
                for u in arr { if let Some(u) = u.as_str() { b.intern_url(Some(u)); } }
            }
            if let Some(arr) = d.get("elements").and_then(|v| v.as_array()) {
                for e in arr { b.push_element(e.clone()); }
            }
        }
        b
    }

    fn intern_str(&mut self, s: &str) -> usize {
        if let Some(&i) = self.string_ord.get(s) { return i; }
        let i = self.strings.len();
        self.strings.push(s.to_string());
        self.string_ord.insert(s.to_string(), i);
        i
    }
    fn intern_url(&mut self, u: Option<&str>) -> i64 {
        match u {
            None => -1,
            Some(u) => {
                if let Some(&i) = self.url_ord.get(u) { return i as i64; }
                let i = self.urls.len();
                self.urls.push(u.to_string());
                self.url_ord.insert(u.to_string(), i);
                i as i64
            }
        }
    }
    fn push_element(&mut self, e: Value) -> usize {
        // dedup key mirrors JS: sigIdx|value|fldIdx|methodOrd|producerOrd|urlIdx
        let key = format!("{}|{}|{}|{}|{}|{}",
            e[0], e[1], e[2], e[3], e[5], e[6]);
        if let Some(&i) = self.elem_ord.get(&key) { return i; }
        let i = self.elements.len();
        self.elements.push(e);
        self.elem_ord.insert(key, i);
        i
    }

    /// Append a STRUCTURAL SENTINEL element (source_url=null) -> returns its ref.
    /// Mirrors evidence-carrier.js structuralSentinel + the compact layout
    /// [sigIdx, value, fldIdx, methodOrd, weight, producerOrd, urlIdx, observedAt].
    pub fn add_sentinel(&mut self, producer: &str, source_field: &str, method: &str) -> usize {
        let p = producer_ord(producer).unwrap_or(0);
        let m = method_ord(method).unwrap_or(9); // structural_injection
        let sig = self.intern_str(source_field);
        let fld = sig; // signal == source_field for a sentinel
        let url = self.intern_url(None);
        let el = json!([sig, "", fld, m, WEIGHTS[m], p, url, Value::Null]);
        self.push_element(el)
    }

    /// Serialize back to the dict Value (top-level graph.evidence_dict).
    pub fn into_value(self) -> Value {
        json!({
            "v": "d0-evidence-v0",
            "producers": PRODUCERS.to_vec(),
            "methods": METHODS.to_vec(),
            "strings": self.strings,
            "source_urls": self.urls,
            "elements": self.elements,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enum_ordinals_match_js() {
        // FROZEN ref space -- MUST equal evidence-carrier.js PRODUCERS/METHODS order.
        assert_eq!(PRODUCERS[1], "rel_extractor");
        assert_eq!(METHODS[2], "cites_xref");
        assert_eq!(METHODS[9], "structural_injection"); // sentinel default ordinal
        assert_eq!(WEIGHTS.len(), METHODS.len());
        assert_eq!(WEIGHTS[0], 1.0); // exact_source_url_xref
    }

    #[test]
    fn reseed_preserves_indices_then_appends() {
        // mesh stage imports the relations dict, then appends a sentinel at the next index.
        let seed = json!({
            "strings": ["base_model"], "source_urls": ["https://u"],
            "elements": [[0, "x", 0, 1, 0.5, 1, 0, Value::Null]],
        });
        let mut b = EvidenceBuilder::from_value(Some(&seed));
        let r = b.add_sentinel("mesh_graph_explains", "knowledge-links.json", "structural_injection");
        assert_eq!(r, 1); // appended after the single imported element (index 0)
        let out = b.into_value();
        assert_eq!(out["elements"].as_array().unwrap().len(), 2);
        // sentinel: method=structural_injection (ord 9), source_url null (urlIdx -1).
        assert_eq!(out["elements"][1][3], 9);
        assert_eq!(out["elements"][1][6], -1);
    }

    #[test]
    fn sentinel_dedups_to_same_ref() {
        let mut b = EvidenceBuilder::from_value(None);
        let a = b.add_sentinel("report_injection", "reports", "structural_injection");
        let c = b.add_sentinel("report_injection", "reports", "structural_injection");
        assert_eq!(a, c); // identical sentinel -> one interned element
    }
}
