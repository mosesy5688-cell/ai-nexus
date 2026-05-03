//! V25.12 Markdown Renderer — Rust FFI for pack-db.js streaming pipeline
//!
//! Replaces the JS path `marked.parse() + sanitizeHtml()` in v25-distiller.js
//! to satisfy the backend principles: Rust-primary, no JS heavy paths in
//! O(N) entity loops.
//!
//! Behavior parity with JS:
//!   - GFM-equivalent: tables, strikethrough, tasklists, footnotes
//!   - `breaks: true` parity: SoftBreak → HardBreak (newlines render as <br>)
//!   - Sanitization: ammonia default allowlist (covers h1-h6, img, etc.)
//!     equivalent to `sanitize-html` defaults + h1/h2/h3 + img[src,alt,width,height]
//!
//! Performance: ~5-10× faster than marked + sanitize-html on typical README,
//! enabling cold-cache pack runs to fit the 6h GHA window.

use ammonia::Builder;
use napi_derive::napi;
use pulldown_cmark::{html, Event, Options, Parser};
use std::sync::LazyLock;

static MD_OPTIONS: LazyLock<Options> = LazyLock::new(|| {
    let mut o = Options::empty();
    o.insert(Options::ENABLE_TABLES);
    o.insert(Options::ENABLE_FOOTNOTES);
    o.insert(Options::ENABLE_STRIKETHROUGH);
    o.insert(Options::ENABLE_TASKLISTS);
    o
});

/// Render Markdown to sanitized HTML.
/// Empty input returns empty string. Render errors fall through to ammonia
/// (any partial HTML still gets sanitized); on no-cache miss-path the JS
/// caller will swallow exceptions to '' to match prior behavior.
#[napi]
pub fn render_html(raw_markdown: String) -> String {
    if raw_markdown.is_empty() {
        return String::new();
    }

    let parser = Parser::new_ext(&raw_markdown, *MD_OPTIONS).map(|e| match e {
        Event::SoftBreak => Event::HardBreak,
        other => other,
    });

    let mut html_buf = String::with_capacity(raw_markdown.len() * 2);
    html::push_html(&mut html_buf, parser);

    Builder::default().clean(&html_buf).to_string()
}
