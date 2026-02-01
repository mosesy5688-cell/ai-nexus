/**
 * RSS Generator V16.2
 * SPEC: SPEC-KNOWLEDGE-MESH-V16.2 Section 9
 * 
 * Generates RSS feeds:
 * - rss/reports.xml - Daily/Annual reports
 * - rss/knowledge.xml - Knowledge articles
 * 
 * Runs in Factory 3.5/4 Linker Job 6
 * 
 * @module scripts/factory/lib/rss-generator
 */

import fs from 'fs/promises';
import path from 'path';

const CONFIG = {
    REPORTS_INDEX_PATH: './output/cache/reports/index.json',
    KNOWLEDGE_INDEX_PATH: './output/cache/knowledge/index.json',
    OUTPUT_DIR: './output/rss',
    SITE_URL: 'https://free2aitools.com',
    VERSION: '16.2'
};

/**
 * Generate RSS XML header
 */
function rssHeader(title, description, link) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
    <title>${escapeXml(title)}</title>
    <description>${escapeXml(description)}</description>
    <link>${link}</link>
    <atom:link href="${link}/rss/${title.toLowerCase().replace(/\s+/g, '-')}.xml" rel="self" type="application/rss+xml"/>
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <generator>Free2AITools Factory V${CONFIG.VERSION}</generator>
`;
}

/**
 * Generate RSS item
 */
function rssItem(title, link, description, pubDate, guid) {
    return `    <item>
        <title>${escapeXml(title)}</title>
        <link>${link}</link>
        <description>${escapeXml(description)}</description>
        <pubDate>${new Date(pubDate).toUTCString()}</pubDate>
        <guid isPermaLink="true">${guid || link}</guid>
    </item>
`;
}

/**
 * Escape XML special characters
 */
function escapeXml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Load JSON file safely
 */
async function loadJson(filePath) {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(content);
    } catch (e) {
        console.warn(`  [WARN] Could not load ${filePath}: ${e.message}`);
        return null;
    }
}

/**
 * Generate reports RSS feed
 */
async function generateReportsRss(outputDir) {
    console.log('  [RSS] Generating reports.xml...');

    const reportsIndex = await loadJson(path.join(outputDir, 'cache', 'reports', 'index.json'));
    if (!reportsIndex?.reports?.length) {
        console.warn('  [WARN] No reports found, skipping RSS');
        return 0;
    }

    let xml = rssHeader(
        'Free2AITools - AI Daily Reports',
        'Daily analysis of AI models, tools, and trends',
        `${CONFIG.SITE_URL}/reports`
    );

    // Add up to 20 most recent reports
    const recentReports = reportsIndex.reports.slice(0, 20);
    for (const report of recentReports) {
        const link = `${CONFIG.SITE_URL}/reports/${report.id}`;
        xml += rssItem(
            report.title || `AI Report ${report.id}`,
            link,
            `${report.highlights || 0} highlights from the AI ecosystem`,
            report.date,
            link
        );
    }

    xml += '</channel>\n</rss>';

    const rssDir = path.join(outputDir, 'rss');
    await fs.mkdir(rssDir, { recursive: true });
    await fs.writeFile(path.join(rssDir, 'reports.xml'), xml);

    return recentReports.length;
}

/**
 * Generate knowledge RSS feed
 */
async function generateKnowledgeRss(outputDir) {
    console.log('  [RSS] Generating knowledge.xml...');

    const knowledgeIndex = await loadJson(path.join(outputDir, 'cache', 'knowledge', 'index.json'));
    if (!knowledgeIndex?.articles?.length) {
        console.warn('  [WARN] No knowledge articles found, skipping RSS');
        return 0;
    }

    let xml = rssHeader(
        'Free2AITools - AI Knowledge Base',
        'Learn about AI concepts, benchmarks, and techniques',
        `${CONFIG.SITE_URL}/knowledge`
    );

    // Add all articles (sorted by refs/popularity)
    const sortedArticles = [...knowledgeIndex.articles].sort((a, b) => (b.refs || 0) - (a.refs || 0));
    for (const article of sortedArticles.slice(0, 50)) {
        const link = `${CONFIG.SITE_URL}/knowledge/${article.slug}`;
        xml += rssItem(
            article.title || article.slug,
            link,
            `${article.category} | Referenced by ${article.refs || 0} models`,
            article.updated || new Date().toISOString().split('T')[0],
            link
        );
    }

    xml += '</channel>\n</rss>';

    const rssDir = path.join(outputDir, 'rss');
    await fs.mkdir(rssDir, { recursive: true });
    await fs.writeFile(path.join(rssDir, 'knowledge.xml'), xml);

    return sortedArticles.length;
}

/**
 * Generate all RSS feeds
 */
export async function generateRssFeeds(outputDir = './output') {
    console.log('[RSS V16.2] Generating RSS feeds...');

    const reportsCount = await generateReportsRss(outputDir);
    const knowledgeCount = await generateKnowledgeRss(outputDir);

    console.log(`[RSS] Generated feeds: ${reportsCount} reports, ${knowledgeCount} articles`);

    return { reports: reportsCount, knowledge: knowledgeCount };
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
    const outputDir = process.argv[2] || './output';
    generateRssFeeds(outputDir)
        .then(result => console.log(`✅ RSS feeds complete: ${result.reports} reports, ${result.knowledge} articles`))
        .catch(e => {
            console.error('❌ RSS generation failed:', e.message);
            process.exit(1);
        });
}
