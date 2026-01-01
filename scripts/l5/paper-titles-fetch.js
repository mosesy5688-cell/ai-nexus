/**
 * L5 Paper Titles Fetcher - V12 Phase 8
 * 
 * Constitution Compliant:
 * - Runs in L5 Sidecar (GitHub Actions)
 * - Fetches paper titles from ArXiv API
 * - Caches results in R2 for frontend use
 * 
 * Output: public/api/cache/paper-titles.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const OUTPUT_DIR = path.join(__dirname, '../../public/api/cache');
const ARXIV_API_BASE = 'https://export.arxiv.org/api/query';
const BATCH_SIZE = 10;
const DELAY_MS = 1000; // Rate limiting

/**
 * Fetch paper metadata from ArXiv API
 */
async function fetchArxivPaper(arxivId) {
    const url = `${ARXIV_API_BASE}?id_list=${arxivId}`;

    try {
        const response = await fetch(url);
        if (!response.ok) return null;

        const xml = await response.text();

        // Simple XML parsing for title (ArXiv returns Atom XML)
        const titleMatch = xml.match(/<title[^>]*>([^<]+)<\/title>/g);
        if (titleMatch && titleMatch.length > 1) {
            // First title is feed title, second is paper title
            const paperTitle = titleMatch[1].replace(/<\/?title[^>]*>/g, '').trim();
            return paperTitle;
        }

        return null;
    } catch (e) {
        console.error(`Failed to fetch ${arxivId}:`, e.message);
        return null;
    }
}

/**
 * Sleep utility for rate limiting
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Main function to fetch all paper titles
 */
async function fetchPaperTitles() {
    console.log('📄 L5 Paper Titles Fetcher Starting...');

    // Load existing paper titles cache
    let existingTitles = {};
    const outputPath = path.join(OUTPUT_DIR, 'paper-titles.json');

    try {
        if (fs.existsSync(outputPath)) {
            existingTitles = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
            console.log(`Loaded ${Object.keys(existingTitles).length} existing titles`);
        }
    } catch (e) {
        console.log('No existing cache, starting fresh');
    }

    // Known paper IDs from model relations (sample - in production, scan from relations)
    // These are common AI/ML papers referenced by models
    const knownPaperIds = [
        '2302.13971', // LLaMA
        '2307.09288', // LLaMA 2
        '2310.06825', // Mistral
        '2309.16609', // Qwen
        '2305.10403', // StarCoder
        '2310.01889', // DeepSeek
        '2308.12950', // Code Llama
        '2401.04088', // DeepSeek MOE
        '2312.11805', // Phi-2
        '2306.05685', // Falcon
        '2305.14314', // Gorilla
        '2305.06161', // GGML/GGUF
        '2307.06435', // Toolformer
        '2304.08485', // Vicuna
        '2303.17564'  // GPT-4 Technical Report
    ];

    // Filter out already cached
    const toFetch = knownPaperIds.filter(id => !existingTitles[id]);
    console.log(`Need to fetch ${toFetch.length} new papers`);

    // Fetch in batches with rate limiting
    for (let i = 0; i < toFetch.length; i++) {
        const arxivId = toFetch[i];
        console.log(`Fetching ${i + 1}/${toFetch.length}: ${arxivId}`);

        const title = await fetchArxivPaper(arxivId);
        if (title) {
            existingTitles[arxivId] = title;
            console.log(`  ✓ ${title.substring(0, 50)}...`);
        } else {
            console.log(`  ✗ Failed to fetch`);
        }

        // Rate limiting
        if (i < toFetch.length - 1) {
            await sleep(DELAY_MS);
        }
    }

    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // Write cache
    const cacheData = {
        generated_at: new Date().toISOString(),
        contract_version: 'V12',
        count: Object.keys(existingTitles).length,
        titles: existingTitles
    };

    fs.writeFileSync(outputPath, JSON.stringify(cacheData, null, 2));
    console.log(`✅ Paper titles written to ${outputPath} (${cacheData.count} papers)`);

    return cacheData;
}

// Run
fetchPaperTitles()
    .then(() => console.log('🎉 Paper titles fetch complete!'))
    .catch(err => {
        console.error('❌ Error:', err);
        process.exit(1);
    });
