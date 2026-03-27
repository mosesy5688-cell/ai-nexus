//! V25.8.3 Content Extractor — Density Booster Core (Rust FFI)
//!
//! Performs CPU-bound HTML→Markdown extraction and 4-bucket content classification
//! for the Factory 1.5 Density Booster pipeline.
//!
//! Classification Buckets (Spec §2.2):
//!   SUCCESS: length > 1000 AND section_headers >= 2
//!   PARTIAL: length 200..1000 (stored, has_fulltext = false)
//!   SKIP:    length < 200 (placeholder / not rendered)
//!   FAILURE: reserved for network errors (handled in JS layer)

use napi::bindgen_prelude::*;
use napi_derive::napi;
use regex::Regex;
use std::sync::LazyLock;

const MIN_QUALITY_LEN: usize = 200;
const FULLTEXT_THRESHOLD: usize = 1000;
const MIN_SECTION_HEADERS: usize = 2;
const MAX_HTML_SIZE: usize = 2_000_000;

// Pre-compiled regexes for HTML extraction
static RE_SCRIPT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<script[\s\S]*?</script>").unwrap());
static RE_STYLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<style[\s\S]*?</style>").unwrap());
static RE_NAV: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<nav[\s\S]*?</nav>").unwrap());
static RE_HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<header[\s\S]*?</header>").unwrap());
static RE_FOOTER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<footer[\s\S]*?</footer>").unwrap());
static RE_HEADING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<(?:h[1-6]|span|div)[^>]*class=[^>]*ltx_title[^>]*>([\s\S]*?)</(?:h[1-6]|span|div)>|<h([1-6])[^>]*>([\s\S]*?)</h[1-6]>").unwrap());
static RE_PARAGRAPH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<(?:p|div)[^>]*class=[^>]*ltx_p[^>]*>([\s\S]*?)</(?:p|div)>|<p[^>]*>([\s\S]*?)</p>").unwrap());
static RE_TAGS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());
static RE_MULTI_NL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());
static RE_MD_HEADING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^#{2,3}\s+\S").unwrap());

#[napi(object)]
pub struct ExtractionResult {
    pub text: String,
    pub classification: String,
    pub char_count: u32,
    pub section_count: u32,
    pub has_fulltext: bool,
}

/// Strip HTML tags and decode common entities.
fn strip_tags(html: &str) -> String {
    let text = RE_TAGS.replace_all(html, " ");
    text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

/// Extract article content from ar5iv HTML, converting to Markdown.
/// Strips nav/header/footer/script/style, preserves section headers.
fn extract_main_content(html: &str) -> String {
    // Truncate oversized HTML (UTF-8 boundary safe)
    let source = if html.len() > MAX_HTML_SIZE {
        // Walk backward from MAX_HTML_SIZE to find a valid UTF-8 char boundary
        let mut end = MAX_HTML_SIZE;
        while end > 0 && !html.is_char_boundary(end) {
            end -= 1;
        }
        &html[..end]
    } else {
        &html
    };

    // Remove non-content elements
    let text = RE_SCRIPT.replace_all(source, "");
    let text = RE_STYLE.replace_all(&text, "");
    let text = RE_NAV.replace_all(&text, "");
    let text = RE_HEADER.replace_all(&text, "");
    let text = RE_FOOTER.replace_all(&text, "");

    // Convert headings to markdown
    // Alt 1: ltx_title class → group 1 = content (level defaults to 2)
    // Alt 2: standard <hN>   → group 2 = level, group 3 = content
    let text = RE_HEADING.replace_all(&text, |caps: &regex::Captures| {
        if let Some(ltx_content) = caps.get(1) {
            // ArXiv ltx_title match — default to ## (level 2)
            let content = strip_tags(ltx_content.as_str()).trim().to_string();
            format!("\n## {}\n", content)
        } else if let (Some(level_match), Some(content_match)) = (caps.get(2), caps.get(3)) {
            // Standard <hN> match
            let level: usize = level_match.as_str().parse().unwrap_or(2);
            let hashes = "#".repeat(level);
            let content = strip_tags(content_match.as_str()).trim().to_string();
            format!("\n{} {}\n", hashes, content)
        } else {
            String::new()
        }
    });

    // Convert paragraphs
    // Alt 1: ltx_p class → group 1 = content
    // Alt 2: standard <p> → group 2 = content
    let text = RE_PARAGRAPH.replace_all(&text, |caps: &regex::Captures| {
        let raw = caps.get(1)
            .or_else(|| caps.get(2))
            .map(|m| m.as_str())
            .unwrap_or("");
        let content = strip_tags(raw).trim().to_string();
        format!("{}\n\n", content)
    });

    // Strip remaining tags
    let text = strip_tags(&text);

    // Normalize whitespace
    let text = RE_MULTI_NL.replace_all(&text, "\n\n");
    text.trim().to_string()
}

/// Count markdown section headers (## or ###).
fn count_section_headers(text: &str) -> usize {
    RE_MD_HEADING.find_iter(text).count()
}

/// Classify content into 4 buckets per Spec §2.2.
fn classify(text: &str, section_count: usize) -> (&'static str, bool) {
    let len = text.len();
    if len >= FULLTEXT_THRESHOLD && section_count >= MIN_SECTION_HEADERS {
        ("SUCCESS", true)
    } else if len >= MIN_QUALITY_LEN {
        ("PARTIAL", false)
    } else {
        ("SKIP", false)
    }
}

/// Extract content from ar5iv HTML and classify it.
/// Core FFI entry point for the Density Booster.
///
/// Input: Raw HTML string from ar5iv fetch.
/// Returns: ExtractionResult with text, classification, and metrics.
#[napi]
pub fn extract_and_classify(html: String) -> ExtractionResult {
    let text = extract_main_content(&html);
    let section_count = count_section_headers(&text);
    let char_count = text.len();
    let (classification, has_fulltext) = classify(&text, section_count);

    ExtractionResult {
        text,
        classification: classification.to_string(),
        char_count: char_count as u32,
        section_count: section_count as u32,
        has_fulltext,
    }
}

/// Classify pre-extracted text (e.g., from S2 API or existing body_content).
/// Use when HTML extraction is not needed.
#[napi]
pub fn classify_text(text: String) -> ExtractionResult {
    let section_count = count_section_headers(&text);
    let char_count = text.len();
    let (classification, has_fulltext) = classify(&text, section_count);

    ExtractionResult {
        text,
        classification: classification.to_string(),
        char_count: char_count as u32,
        section_count: section_count as u32,
        has_fulltext,
    }
}

/// Batch classify multiple pre-extracted texts.
/// Input: newline-delimited texts separated by \x00 (null byte).
/// Returns: Vec of classification strings in same order.
#[napi]
pub fn batch_classify(texts_buffer: Buffer) -> Vec<String> {
    let data = std::str::from_utf8(&texts_buffer).unwrap_or("");
    data.split('\0')
        .map(|text| {
            let sections = count_section_headers(text);
            let (cls, _) = classify(text, sections);
            cls.to_string()
        })
        .collect()
}

// ── Fusion Protocol (Spec §3.2) ─────────────────────────────────

static RE_R2_UMID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"enrichment/fulltext/[a-f0-9]{2}/([a-f0-9]+)\.md\.gz$").unwrap());

/// Build enrichment manifest from R2 key list.
/// Spec §3.2: Parses R2 keys into UMID→Key map entries.
/// Input: newline-delimited R2 keys.
/// Returns: Vec of [umid, key] pairs (only matching keys).
#[napi]
pub fn build_enrichment_manifest(keys_buffer: Buffer) -> Vec<Vec<String>> {
    let data = std::str::from_utf8(&keys_buffer).unwrap_or("");
    data.lines()
        .filter_map(|key| {
            RE_R2_UMID.captures(key).map(|caps| {
                vec![caps[1].to_string(), key.to_string()]
            })
        })
        .collect()
}

/// Validate fused content after R2 download (Fusion quality gate).
/// Ensures injected fulltext meets the dual-signal threshold.
/// Returns: ExtractionResult with has_fulltext = true only if quality passes.
#[napi]
pub fn validate_fusion_content(fulltext: String, original_body: String) -> ExtractionResult {
    // Only upgrade if fulltext is strictly richer than original
    if fulltext.len() <= original_body.len() {
        return classify_text(original_body);
    }
    classify_text(fulltext)
}

#[cfg(test)]
mod tests;

