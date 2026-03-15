use super::*;

#[test]
fn test_extract_minimal() {
    let html = "<p>Short.</p>";
    let result = extract_and_classify(html.to_string());
    assert_eq!(result.classification, "SKIP");
    assert!(!result.has_fulltext);
}

#[test]
fn test_extract_partial() {
    let body = "A ".repeat(150);
    let html = format!("<p>{}</p>", body);
    let result = extract_and_classify(html);
    assert_eq!(result.classification, "PARTIAL");
    assert!(!result.has_fulltext);
}

#[test]
fn test_extract_success() {
    let body = "A ".repeat(600);
    let html = format!(
        "<h2>Introduction</h2><p>{}</p><h2>Methods</h2><p>{}</p><h3>Results</h3><p>{}</p>",
        body, body, body
    );
    let result = extract_and_classify(html);
    assert_eq!(result.classification, "SUCCESS");
    assert!(result.has_fulltext);
    assert!(result.section_count >= 2);
}

#[test]
fn test_strip_script_style() {
    let html = "<script>alert('x')</script><p>Content here</p><style>.x{}</style>";
    let result = extract_and_classify(html.to_string());
    assert!(!result.text.contains("alert"));
    assert!(!result.text.contains(".x{}"));
    assert!(result.text.contains("Content here"));
}

#[test]
fn test_classify_text_direct() {
    let text = format!("## Intro\nSome text.\n## Methods\n{}", "word ".repeat(300));
    let result = classify_text(text);
    assert_eq!(result.classification, "SUCCESS");
    assert!(result.has_fulltext);
}

#[test]
fn test_heading_preservation() {
    let html = "<h2>Section One</h2><p>Body text here.</p>";
    let result = extract_and_classify(html.to_string());
    assert!(result.text.contains("## Section One"));
}

#[test]
fn test_build_manifest() {
    let keys = "enrichment/fulltext/0a/0a1b2c3d4e5f6789.md.gz\nother/file.json\nenrichment/fulltext/ff/ff00112233445566.md.gz\n";
    let buffer = Buffer::from(keys.as_bytes().to_vec());
    let result = build_enrichment_manifest(buffer);
    assert_eq!(result.len(), 2);
    assert_eq!(result[0][0], "0a1b2c3d4e5f6789");
    assert_eq!(result[1][0], "ff00112233445566");
}

#[test]
fn test_validate_fusion_upgrade() {
    let original = "Short abstract only.".to_string();
    let fulltext = format!("## Intro\nLong text here.\n## Methods\n{}", "data ".repeat(300));
    let result = validate_fusion_content(fulltext, original);
    assert!(result.has_fulltext);
    assert_eq!(result.classification, "SUCCESS");
}

#[test]
fn test_validate_fusion_no_downgrade() {
    let original = format!("## A\n## B\n{}", "word ".repeat(600));
    let shorter = "Too short.".to_string();
    let result = validate_fusion_content(shorter, original.clone());
    assert_eq!(result.text, original);
}
