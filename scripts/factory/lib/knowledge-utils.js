/**
 * Knowledge Utils V16.2.1
 * Shared parsing and categorization logic for knowledge data generation.
 * Constitutional: Art 5.1 (File Size limit adherence)
 */

/**
 * Get category for a slug based on predefined mappings
 * @param {string} slug 
 * @param {Object} categories 
 * @returns {string}
 */
export function getCategory(slug, categories) {
    for (const [category, slugs] of Object.entries(categories)) {
        if (slugs.includes(slug)) return category;
    }
    return 'concepts';
}

/**
 * Parse markdown frontmatter
 * @param {string} content 
 * @returns {Object}
 */
export function parseFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};

    const frontmatter = {};
    const lines = match[1].split('\n');
    for (const line of lines) {
        const [key, ...valueParts] = line.split(':');
        if (key && valueParts.length) {
            frontmatter[key.trim()] = valueParts.join(':').trim();
        }
    }
    return frontmatter;
}

/**
 * Extract content sections from markdown based on ## headings
 * @param {string} content 
 * @returns {Object}
 */
export function extractSections(content) {
    const sections = {};
    const bodyMatch = content.match(/---\n[\s\S]*?\n---\n([\s\S]*)/);
    if (!bodyMatch) return sections;

    const body = bodyMatch[1];
    const headingRegex = /^##\s+(.+)$/gm;
    let match;
    let lastHeading = 'overview';
    let lastIndex = 0;

    while ((match = headingRegex.exec(body)) !== null) {
        if (lastIndex > 0) {
            sections[lastHeading] = body.slice(lastIndex, match.index).trim();
        }
        lastHeading = match[1].toLowerCase().replace(/\s+/g, '_');
        lastIndex = match.index + match[0].length;
    }

    if (lastIndex > 0) {
        sections[lastHeading] = body.slice(lastIndex).trim();
    }

    return sections;
}
