/**
 * ArXiv XML Parser Utilities
 * 
 * Parses ArXiv API XML responses into structured data
 * Split from arxiv-adapter.js for CES compliance (<250 lines)
 * 
 * @module ingestion/adapters/arxiv-parser
 */

/**
 * Parse ArXiv XML response
 */
export function parseArxivXML(xmlText) {
    const papers = [];
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    let match;

    while ((match = entryRegex.exec(xmlText)) !== null) {
        const entryXml = match[1];

        const paper = {
            id: extractTag(entryXml, 'id'),
            title: extractTag(entryXml, 'title')?.replace(/\s+/g, ' ').trim(),
            summary: extractTag(entryXml, 'summary')?.replace(/\s+/g, ' ').trim(),
            published: extractTag(entryXml, 'published'),
            updated: extractTag(entryXml, 'updated'),
            authors: extractAuthors(entryXml),
            categories: extractCategories(entryXml),
            links: extractLinks(entryXml),
            _fetchedAt: new Date().toISOString()
        };

        // Extract ArXiv ID from URL
        paper.arxiv_id = paper.id?.match(/abs\/(.+)$/)?.[1] || paper.id;
        papers.push(paper);
    }

    return papers;
}

function extractTag(xml, tagName) {
    const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
    const match = xml.match(regex);
    return match ? match[1].trim() : null;
}

function extractAuthors(xml) {
    const authors = [];
    const authorRegex = /<author>\s*<name>([^<]+)<\/name>/g;
    let match;
    while ((match = authorRegex.exec(xml)) !== null) {
        authors.push(match[1].trim());
    }
    return authors;
}

function extractCategories(xml) {
    const categories = [];
    const catRegex = /<category[^>]*term="([^"]+)"/g;
    let match;
    while ((match = catRegex.exec(xml)) !== null) {
        categories.push(match[1]);
    }
    return categories;
}

function extractLinks(xml) {
    const links = {};

    // PDF link
    const pdfMatch = xml.match(/<link[^>]*title="pdf"[^>]*href="([^"]+)"/);
    if (pdfMatch) links.pdf = pdfMatch[1];

    // Abstract page
    const absMatch = xml.match(/<link[^>]*type="text\/html"[^>]*href="([^"]+)"/);
    if (absMatch) links.abstract = absMatch[1];

    return links;
}

/**
 * Clean title by removing extra whitespace
 */
export function cleanTitle(title) {
    if (!title) return 'Untitled Paper';
    return title.replace(/\s+/g, ' ').trim();
}

/**
 * Extract tags from ArXiv paper
 */
export function extractTags(raw) {
    const tags = [];

    // Add ArXiv categories as tags
    for (const cat of raw.categories || []) {
        tags.push(`arxiv:${cat}`);
    }

    // Extract keywords from title
    const keywords = ['transformer', 'llm', 'diffusion', 'bert', 'gpt',
        'attention', 'neural', 'deep learning', 'gan', 'vae', 'clip',
        'multimodal', 'vision', 'language', 'reinforcement'];

    const titleLower = (raw.title || '').toLowerCase();
    for (const kw of keywords) {
        if (titleLower.includes(kw)) {
            tags.push(kw);
        }
    }

    return [...new Set(tags)];
}

/**
 * Build meta_json for ArXiv paper
 */
export function buildMetaJson(raw) {
    return {
        arxiv_id: raw.arxiv_id,
        authors: raw.authors || [],
        categories: raw.categories || [],
        primary_category: raw.categories?.[0] || null,
        pdf_url: raw.links?.pdf || null,
        published_date: raw.published,
        updated_date: raw.updated
    };
}

/**
 * Calculate paper quality score
 */
export function calculatePaperQuality(entity) {
    let score = 0;

    // Abstract length
    const abstractLength = entity.body_content?.length || 0;
    if (abstractLength > 200) score += 20;
    if (abstractLength > 500) score += 10;

    // Has multiple authors
    const authorsCount = entity.meta_json?.authors?.length || 0;
    score += Math.min(20, authorsCount * 5);

    // Has categories
    if (entity.tags.length > 0) score += 20;

    // Has PDF link
    if (entity.meta_json?.pdf_url) score += 10;

    // Title quality
    if (entity.title.length > 20) score += 10;

    return Math.min(100, score);
}
