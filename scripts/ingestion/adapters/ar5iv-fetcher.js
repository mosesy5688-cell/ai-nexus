/**
 * Ar5iv Full-Text HTML Fetcher
 * V25.8: Deep Paper enrichment via ar5iv.labs.arxiv.org
 *
 * Fetches semantic HTML renderings of ArXiv papers for:
 * - Full-text search indexing (FTS5)
 * - Knowledge mesh keyword extraction
 * - SEO-rich body_content generation
 *
 * Rate-limited to respect ar5iv infrastructure (5s between requests).
 */

const AR5IV_BASE = 'https://ar5iv.labs.arxiv.org/html';
const FETCH_TIMEOUT_MS = 15000;
const RATE_LIMIT_MS = 5000;
const MAX_HTML_SIZE = 500000; // 500KB cap per paper

let _lastFetchTime = 0;

/**
 * Fetch full-text HTML for a single ArXiv paper.
 * @param {string} arxivId - e.g. "2401.12345" or "2401.12345v2"
 * @returns {string|null} Cleaned HTML text or null on failure
 */
export async function fetchAr5ivHtml(arxivId) {
    if (!arxivId) return null;

    // Strip version suffix for ar5iv (uses latest)
    const cleanId = arxivId.replace(/v\d+$/, '');
    const url = `${AR5IV_BASE}/${cleanId}`;

    // Rate limiting
    const now = Date.now();
    const elapsed = now - _lastFetchTime;
    if (elapsed < RATE_LIMIT_MS) {
        await new Promise(r => setTimeout(r, RATE_LIMIT_MS - elapsed));
    }
    _lastFetchTime = Date.now();

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Free2AITools-Scholar/1.0 (academic-indexing)',
                'Accept': 'text/html'
            },
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (!response.ok) {
            if (response.status === 404) return null; // Paper not yet rendered
            console.warn(`[AR5IV] HTTP ${response.status} for ${arxivId}`);
            return null;
        }

        const html = await response.text();
        if (html.length > MAX_HTML_SIZE) {
            return extractMainContent(html.substring(0, MAX_HTML_SIZE));
        }
        return extractMainContent(html);
    } catch (e) {
        if (e.name === 'AbortError') {
            console.warn(`[AR5IV] Timeout for ${arxivId}`);
        }
        return null;
    }
}

/**
 * Extract main article content from ar5iv HTML, stripping nav/header/footer.
 * Returns plain text with section headers preserved.
 */
function extractMainContent(html) {
    // Remove script/style/nav/header/footer tags
    let text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '');

    // Preserve section headers as markdown
    text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) => {
        const hashes = '#'.repeat(parseInt(level));
        return `\n${hashes} ${stripTags(content).trim()}\n`;
    });

    // Preserve paragraphs
    text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, content) => {
        return stripTags(content).trim() + '\n\n';
    });

    // Strip remaining tags
    text = stripTags(text);

    // Clean whitespace
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    // Minimum quality check
    if (text.length < 200) return null;
    return text;
}

function stripTags(html) {
    return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

/**
 * Batch fetch for multiple papers with progress tracking.
 * @param {Array<{arxiv_id: string}>} papers - Papers to enrich
 * @param {number} maxCount - Maximum papers to fetch (budget control)
 * @returns {Map<string, string>} arxivId -> fullText
 */
export async function batchFetchAr5iv(papers, maxCount = 500) {
    console.log(`[AR5IV] Batch enrichment: ${Math.min(papers.length, maxCount)} papers...`);
    const results = new Map();
    let fetched = 0, success = 0;

    for (const paper of papers) {
        if (fetched >= maxCount) break;
        const id = paper.arxiv_id;
        if (!id) continue;

        const html = await fetchAr5ivHtml(id);
        fetched++;
        if (html) {
            results.set(id, html);
            success++;
        }

        if (fetched % 50 === 0) {
            console.log(`  [AR5IV] Progress: ${fetched}/${maxCount} (${success} enriched)`);
        }
    }

    console.log(`[AR5IV] Complete: ${success}/${fetched} papers enriched with full text`);
    return results;
}
