import axios from 'axios';
import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';
import path from 'path';
import cheerio from 'cheerio';
import { fileURLToPath } from 'url';

// --- Configuration ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CIVITAI_DATA_PATH = path.join(__dirname, '../src/data/civitai.json');
const HUGGINGFACE_API_URL = 'https://huggingface.co/api/models?sort=likes&direction=-1&limit=100';
const OUTPUT_FILE_PATH = path.join(__dirname, '../src/data/models.json');
const KEYWORDS_OUTPUT_PATH = path.join(__dirname, '../src/data/keywords.json');
const REPORTS_OUTPUT_PATH = path.join(__dirname, '../src/data/reports.json');
const ARCHIVE_DIR = path.join(__dirname, '../src/data/archives');
const REPORT_ARCHIVE_DIR = path.join(__dirname, '../src/data/report-archives');
const REPLICATE_EXPLORE_URL = 'https://replicate.com/explore';
const NSFW_KEYWORDS = [
    'nsfw', 
    'porn', 
    'hentai', 
    'sexy', 
    'explicit', 
    'erotic', 
    'nude', 
    'naked',
    'adult'
];

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
const geminiModel = genAI ? genAI.getGenerativeModel({ model: 'gemini-2.5-flash' }) : null;

/**
 * Builds the prompt for the AI weekly report generation.
 * @param {string} reportId - The ID for the report (YYYY-MM-DD).
 * @param {string} dateString - The formatted date string for the title.
 * @param {Array<string>} featuredModelIds - An array of featured model IDs.
 * @param {Array<object>} latestModels - A list of the latest models for context.
 * @returns {string} The complete prompt string.
 */
function buildReportPrompt(reportId, dateString, featuredModelIds, latestModels) {
    const prompt = `
    As an AI industry analyst, generate a weekly report on trends in the open-source AI model landscape based on the provided list of trending models. Your output MUST be a single, valid, parsable JSON string. Do not include any text or markdown formatting before or after the JSON block. The entire response should be only the JSON object.

    The JSON object must strictly adhere to this exact structure:
    {
      "reportId": "YYYY-MM-DD",
      "title": "Weekly AI Model & Tech Report [Date]",
      "date": "YYYY-MM-DD",
      "summary": "A concise, engaging summary of this week's key AI advancements, suitable for a preview card. Max 2-3 sentences.",
      "sections": [
        {"heading": "Key Technology Breakthroughs", "content": "Detailed analysis of significant technical innovations and new model architectures. Use Markdown for formatting.", "keywords": ["technical-innovation", "new-architecture", "performance-gains"]},
        {"heading": "Popular Product Applications & Market Trends", "content": "Analysis of how new models are being applied in products and emerging market trends. Use Markdown for formatting.", "keywords": ["market-trends", "use-cases", "application-spotlight"]},
        {"heading": "Community Spotlight & Rising Stars", "content": "Highlight interesting or rapidly growing models from the community that might not be at the top of the leaderboards yet. Use Markdown for formatting.", "keywords": ["community-highlight", "rising-star", "innovative-tools"]}
      ],
      "featuredModelIds": ["model-id-1", "model-id-2"],
      "tags": ["weekly-report", "ai-trends", "llm-analysis"]
    }

    Instructions:
    1.  Use '${reportId}' for "reportId" and "date".
    2.  The title must be exactly "Weekly AI Model & Tech Report [Date]", where [Date] is replaced with "${dateString}".
    3.  The 'summary' must be brief and compelling.
    4.  The 'content' for each section must be detailed, insightful, and written in English using Markdown for formatting (e.g., **bold**, *italic*, links).
    5.  The 'keywords' for each section should be relevant lowercase strings.
    6.  The 'featuredModelIds' array must contain exactly these two IDs: ${JSON.stringify(featuredModelIds)}.
    7.  The 'tags' array should contain general tags for the report itself.
    8.  Analyze the following trending models to inform your report: ${JSON.stringify(latestModels, null, 2)}
    `;

    return prompt.trim();
}

/**
 * Generates a weekly AI report using the Groq API based on the latest models.
 * @param {Array<object>} models The list of recently fetched models.
 * @returns {Promise<void>}
 */
async function generateAIWeeklyReport(models) {
    if (!geminiModel) {
        console.warn('- GEMINI_API_KEY not found. Skipping AI report generation.');
        return null;
    }

    // Pre-condition check: Ensure there are enough models to generate a meaningful report.
    if (models.length < 2) {
        console.warn('- Not enough models (< 2) to generate a weekly report. Skipping.');
        return null;
    }

    console.log('- Generating AI weekly report...');
    const latestModels = models.slice(0, 15).map(m => ({ id: m.id, name: m.name, task: m.task, likes: m.likes, description: m.description.substring(0, 100) }));
    const featuredModelIds = latestModels.length >= 2 ? latestModels.slice(0, 2).map(m => m.id) : [];
    const today = new Date();
    const reportId = today.toISOString().split('T')[0];
    const dateString = today.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    const prompt = buildReportPrompt(reportId, dateString, featuredModelIds, latestModels);

    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const result = await geminiModel.generateContent(prompt);
            const responseText = result.response.text().trim();

            // Clean the response to ensure it's a valid JSON string, removing markdown code blocks
            const jsonString = responseText.replace(/^```(?:json)?\s*|\s*```$/g, '');

            // Validate and parse the JSON
            const report = JSON.parse(jsonString);

            // Final check for required fields
            if (report.reportId && report.title && report.sections) {
                console.log(`✅ AI weekly report generated successfully for ${reportId} on attempt ${attempt}.`);
                return report;
            } else {
                throw new Error("Generated JSON is missing required fields.");
            }
        } catch (error) {
            console.error(`❌ Attempt ${attempt} failed to generate AI weekly report:`, error.message);
            if (attempt < MAX_RETRIES) {
                const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
                console.log(`- Retrying in ${delay / 1000} seconds...`);
                await sleep(delay);
            }
        }
    }

    console.error('❌ AI report generation failed after all retries.');

    // Fallback to a placeholder report if AI generation fails
    console.log('- Creating a fallback report...');
    const fallbackReport = {
      reportId: reportId,
      title: `Weekly AI Model & Tech Report ${dateString}`,
      date: reportId,
      summary: "This week's AI-generated analysis is temporarily unavailable. In the meantime, explore the top models that have been trending in the community.",
      sections: [
        {
          heading: "This Week's Hot Models",
          content: "While our AI analyst is taking a short break, here are the models that captured the community's attention this week. Dive into their details to discover the latest innovations.",
          keywords: ["trending-now", "top-models"]
        }
      ],
      featuredModelIds: featuredModelIds,
      tags: ["fallback-report", "weekly-highlights"]
    };
    return fallbackReport;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getModelKey(name) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Fetches a README from a given URL. Returns null if it fails.
 * @param {string} url - The URL of the README file.
 * @param {object} [config] - Optional axios config.
 * @returns {Promise<string|null>}
 */
async function fetchReadme(url, config = {}) {
    try {
        const response = await axios.get(url, config);
        return response.data;
    } catch (error) {
        // It's okay if a README doesn't exist.
        return null;
    }
}

/**
 * Fetches and transforms data from Replicate by scraping the explore page.
 * @returns {Promise<Array<object>>} A promise that resolves to an array of transformed model data.
 */
async function fetchReplicateData() {
    console.log('📦 Fetching data from Replicate...');
    try {
        const { data } = await axios.get(REPLICATE_EXPLORE_URL);
        const $ = cheerio.load(data);
        const models = [];

        $('a[href^="/p/"]').each((i, el) => {
            if (models.length >= 30) return false; // Limit to top 30 models

            const href = $(el).attr('href');
            const name = $(el).find('h4').text().trim();
            const author = $(el).find('h5').text().trim().replace(/^by\s+/, '');
            const description = $(el).find('p[class*="text-sm"]').text().trim();

            if (href && name && author) {
                models.push({
                    id: `replicate-${author}/${name.toLowerCase().replace(/\s+/g, '-')}`,
                    name: name,
                    author: author,
                    description: description || 'A model from Replicate.',
                    task: 'N/A', // Replicate doesn't provide a standard task tag on the explore page
                    tags: ['replicate'],
                    likes: 0, // Likes are not available on the explore page
                    downloads: 0, // Downloads are not available
                    lastModified: new Date().toISOString(),
                    readme: null,
                    downloadUrl: null,
                    sources: [{ platform: 'Replicate', url: `https://replicate.com${href}` }],
                    thumbnail: null,
                });
            }
        });
        console.log(`✅ Successfully fetched and transformed ${models.length} models from Replicate.`);
        return models;
    } catch (error) {
        console.error('❌ Failed to fetch data from Replicate:', error.message);
        return [];
    }
}

async function fetchHuggingFaceData() {
    console.log('📦 Fetching data from HuggingFace API...');
    try {
        const { data } = await axios.get(HUGGINGFACE_API_URL);

        const transformedData = await Promise.all(data.map(async (model) => {
            const readmeUrl = `https://huggingface.co/${model.modelId}/raw/main/README.md`;
            const readmeContent = await fetchReadme(readmeUrl);

            // Attempt to find a direct download URL
            const files = model.siblings?.map(s => s.rfilename) || [];
            const safetensorFile = files.find(f => f.endsWith('.safetensors'));
            // Use the main model URL as a fallback if no direct link is found
            const modelUrl = `https://huggingface.co/${model.modelId}`;
            const downloadUrl = safetensorFile
                ? `https://huggingface.co/${model.modelId}/resolve/main/${safetensorFile}`
                : null;

            return {
                id: model.modelId,
                name: model.modelId.split('/')[1] || model.modelId,
                author: model.author,
                description: model.cardData?.description || `A model for ${model.pipeline_tag || 'various tasks'}.`,
                task: model.pipeline_tag || 'N/A',
                tags: model.tags || [],
                likes: model.likes || 0,
                downloads: model.downloads || 0,
                lastModified: model.lastModified,
                readme: readmeContent,
                thumbnail: null, // Images are disabled
                downloadUrl: downloadUrl,
                sources: [{
                    platform: 'Hugging Face',
                    url: modelUrl,
                    author: model.author,
                    modelId: model.modelId,
                }],
            };
        }));

        console.log(`✅ Successfully fetched and transformed ${transformedData.length} models.`);
        return transformedData;
    } catch (error) {
        console.error('❌ Failed to fetch data from HuggingFace:', error.message);
        return []; // Return empty on error to avoid breaking the build
    }
}

async function fetchGitHubData() {
    console.log('📦 Fetching data from GitHub API...');
    const GITHUB_API_URL = 'https://api.github.com/search/repositories?q=topic:ai-tool&sort=stars&order=desc&per_page=50';
    try {
        const { data } = await axios.get(GITHUB_API_URL, {
            headers: { 'Accept': 'application/vnd.github.v3+json' }
        });

        const transformedData = await Promise.all(data.items.map(async (repo) => {
            const readmeUrl = `https://api.github.com/repos/${repo.full_name}/readme`;
            const readmeContent = await fetchReadme(readmeUrl, { headers: { 'Accept': 'application/vnd.github.raw' } });

            if (!readmeContent) {
                console.warn(`- Could not fetch README for ${repo.full_name}`);
            }
            return {
                id: `github-${repo.full_name.replace('/', '-')}`,
                name: repo.name,
                author: repo.owner.login,
                description: repo.description || 'An AI tool from GitHub.',
                task: 'tool', // Assign a default task for GitHub repos
                tags: repo.topics || [],
                likes: repo.stargazers_count || 0,
                downloads: repo.watchers_count || 0, // Using watchers as a proxy for downloads
                lastModified: repo.updated_at,
                readme: readmeContent,
                downloadUrl: null, // GitHub repos don't have a standard direct download URL
                sources: [{
                    platform: 'GitHub',
                    url: repo.html_url,
                    owner: repo.owner.login,
                    repo: repo.name
                }],
                thumbnail: null, // Images are disabled
            };
        }));

        console.log(`✅ Successfully fetched and transformed ${transformedData.length} models from GitHub.`);
        return transformedData;
    } catch (error) {
        console.error('❌ Failed to fetch data from GitHub:', error.message);
        // Specifically check for rate limit errors, which are common in CI
        if (error.response && error.response.status === 403) {
            console.error('    - This might be a GitHub API rate limit issue. Check your GITHUB_TOKEN permissions.');
            console.error(`    - Status: ${error.response.status}`);
            console.error(`    - Data: ${JSON.stringify(error.response.data)}`);
        }
        return []; // Return empty on error to avoid breaking the build
    }
}

function readCivitaiData() {
    console.log('📦 Reading data from Civitai JSON file...');
    try {
        if (!fs.existsSync(CIVITAI_DATA_PATH)) {
            console.warn(`- Civitai data file not found at ${CIVITAI_DATA_PATH}. Skipping.`);
            return [];
        }
        const civitaiData = JSON.parse(fs.readFileSync(CIVITAI_DATA_PATH, 'utf-8'));
        const transformedData = civitaiData.map(model => {
            const description = model.description || `An image generation model named '${model.name}' from Civitai, created by ${model.creator?.username || 'Unknown'}.`;
            
            // Fix for Civitai tags which can be an array of objects {name: 'tag'}
            const tags = Array.isArray(model.tags) 
                ? model.tags.map(tag => typeof tag === 'object' && tag.name ? tag.name : tag).filter(t => typeof t === 'string') 
                : [];

            return {
            id: `civitai-${model.name.toLowerCase().replace(/\s+/g, '-')}`,
            name: model.name,
            author: model.creator?.username || 'Civitai Community',
            description: description,
            task: 'image-generation', // Assume all are image generation for now
            tags: tags,
            likes: model.stats?.favoriteCount || 0,
            downloads: model.stats?.downloadCount || 0,
            lastModified: model.lastUpdate || new Date().toISOString(),
            readme: model.description || null, // Use the raw HTML description directly as readme
            thumbnail: null, // Images are disabled
            downloadUrl: model.downloadUrl, // Assuming the JSON has this field
            sources: [{ // Standardize source object
                platform: 'Civitai',
                url: `https://civitai.com/models/${model.id}`,
                modelId: model.id,
                creator: model.creator?.username,
            }],
        }
    });
        console.log(`✅ Successfully read and transformed ${transformedData.length} models from Civitai.`);
        return transformedData;
    } catch (error) {
        console.error('❌ Failed to read or parse Civitai data:', error.message);
        return []; // Return empty array on error to not break the build
    }
}

function writeDataToFile(filePath, data) {
    console.log(`- Writing data to static file: ${filePath}`);
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        console.log('✅ Successfully wrote data to file.');
    } catch (error) {
        console.error('❌ Failed to write data to file:', error.message);
        process.exit(1);
    }
}

async function writeToKV(key, value) {
    if (process.env.CI) {
        console.log('CI environment detected, writing to Cloudflare KV...');
        const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, KV_NAMESPACE_ID } = process.env;

        if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN || !KV_NAMESPACE_ID) {
            console.warn('⚠️ Missing Cloudflare credentials for KV write. Skipping KV update, but continuing build.');
            return; // Exit the function gracefully
        }

        const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${key}`;

        try {
            await axios.put(url, value, {
                headers: {
                    'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            });
            console.log(`✅ Successfully wrote data for key: "${key}" to Cloudflare KV.`);
        } catch (error) {
            console.error('❌ Failed to write data to Cloudflare KV:', error.message);
            if (error.response) {
                console.error('    - Error details:', error.response.data);
            }
            process.exit(1);
        }
    } else {
        console.log('Not in CI environment, skipping KV write.');
    }
}

function isNsfw(model) {
    const name = model.name.toLowerCase();
    const description = (model.description || '').toLowerCase();
    const tags = (model.tags || []).map(t => t.toLowerCase());

    for (const keyword of NSFW_KEYWORDS) {
        if (name.includes(keyword) || description.includes(keyword) || tags.includes(keyword)) {
            return true;
        }
    }
    return false;
}

/**
 * Cleans and normalizes a keyword string.
 * @param {string} keyword - The keyword to clean.
 * @returns {string} The cleaned keyword.
 */
function cleanKeyword(keyword) {
    return keyword.toLowerCase().trim().replace(/[\s_]+/g, '-');
}

/**
 * Extracts keywords from a given text string (name or description).
 * @param {string} text - The text to extract keywords from.
 * @returns {string[]} An array of potential keywords.
 */
function extractKeywordsFromText(text) {
    if (!text) return [];
    // This regex splits by spaces, hyphens, and slashes, and removes common punctuation.
    return text.toLowerCase().split(/[\s\-/]+/)
        .map(word => word.replace(/[^a-z0-9-]/g, ''))
        .filter(word => word.length > 2 && word.length < 20 && !/^\d+$/.test(word));
}

/**
 * Discovers, scores, and saves keywords based on their frequency, source, and associated model popularity.
 * @param {Array<object>} models - The list of all models.
 */
function discoverAndSaveKeywords(models) {
    console.log('- Discovering and scoring keywords...');
    const keywordScores = new Map();
    const excludedTags = new Set(['transformers', 'safetensors', 'pytorch', 'diffusers', 'en', 'license:mit', 'region:us', 'custom_code', 'gguf', 'model-index']);

    const WEIGHTS = {
        TAG: 5,
        NAME: 3,
        DESCRIPTION: 1,
        LIKE_MULTIPLIER: 0.0001 // Add a small score fraction based on model likes
    };

    models.forEach(model => {
        const seenKeywords = new Set(); // To ensure a keyword is counted only once per model

        // Process tags (highest weight)
        (model.tags || []).forEach(tag => {
            const cleaned = cleanKeyword(tag);
            if (cleaned && !excludedTags.has(cleaned) && !cleaned.includes(':') && cleaned.length > 2 && cleaned.length < 25) {
                if (!seenKeywords.has(cleaned)) {
                    const score = (keywordScores.get(cleaned)?.score || 0) + WEIGHTS.TAG + (model.likes * WEIGHTS.LIKE_MULTIPLIER);
                    const count = (keywordScores.get(cleaned)?.count || 0) + 1;
                    keywordScores.set(cleaned, { score, count });
                    seenKeywords.add(cleaned);
                }
            }
        });

        // Process model name (medium weight)
        extractKeywordsFromText(model.name).forEach(keyword => {
            if (!excludedTags.has(keyword) && !seenKeywords.has(keyword)) {
                const score = (keywordScores.get(keyword)?.score || 0) + WEIGHTS.NAME + (model.likes * WEIGHTS.LIKE_MULTIPLIER);
                const count = (keywordScores.get(keyword)?.count || 0) + 1;
                keywordScores.set(keyword, { score, count });
                seenKeywords.add(keyword);
            }
        });

        // Process description (lowest weight)
        extractKeywordsFromText(model.description).forEach(keyword => {
            if (!excludedTags.has(keyword) && !seenKeywords.has(keyword)) {
                const score = (keywordScores.get(keyword)?.score || 0) + WEIGHTS.DESCRIPTION;
                // We don't add like multiplier here to avoid over-inflating common words from popular model descriptions
                const count = (keywordScores.get(keyword)?.count || 0) + 1;
                keywordScores.set(keyword, { score, count });
                seenKeywords.add(keyword);
            }
        });
    });

    // Filter out keywords that appear only once, as they are likely noise
    const filteredKeywords = Array.from(keywordScores.entries()).filter(([, data]) => data.count > 1);

    // Sort by score and take the top keywords
    const sortedKeywords = filteredKeywords
        .sort(([, a], [, b]) => b.score - a.score)
        .slice(0, 50) // Increase the number of hot keywords to 50 for better coverage
        .map(([slug, data]) => ({
            slug: slug,
            title: slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
            count: data.count
        }));

    // --- VALIDATION STEP ---
    // Ensure every keyword in the list corresponds to at least one model's tag.
    // This prevents showing tags on the frontend that lead to zero results.
    const allModelTags = new Set(models.flatMap(m => m.tags || []));
    const validatedKeywords = sortedKeywords.filter(keyword => allModelTags.has(keyword.slug));

    // Final sort by count to display the most frequent ones first on the UI if needed.
    // This is applied after validation to ensure the final list is both relevant and popular.
    validatedKeywords.sort((a, b) => b.count - a.count);

    writeDataToFile(KEYWORDS_OUTPUT_PATH, validatedKeywords);
    console.log(`✅ Discovered ${sortedKeywords.length} potential keywords, saved ${validatedKeywords.length} validated hot keywords.`);
}

/**
 * Reads existing reports, adds a new one, and writes back to the file.
 * Ensures the file exists to prevent build errors.
 * @param {object | null} newReport The new report to add.
 */
async function updateReportsFile(newReport) {
  let reports = [];
  if (fs.existsSync(REPORTS_OUTPUT_PATH)) {
    try {
      reports = JSON.parse(fs.readFileSync(REPORTS_OUTPUT_PATH, 'utf-8'));
    } catch (e) {
      console.warn('Could not parse existing reports.json. Starting fresh.');
    }
  }

  if (newReport) {
    // Long-term archival: Save the new report as a separate file
    const reportArchivePath = path.join(REPORT_ARCHIVE_DIR, `${newReport.reportId}.json`);
    writeDataToFile(reportArchivePath, newReport);

    // Main reports file: Add new report to the beginning
    reports.unshift(newReport); // Add new report to the beginning
  }

  // Keep only the latest 52 reports for the main page to ensure performance
  writeDataToFile(REPORTS_OUTPUT_PATH, reports.slice(0, 52)); 
}

/**
 * Initializes necessary directories and empty data files to prevent build errors.
 */
function initializeDirectories() {
    console.log('- Initializing required directories and files...');
    // Ensure data directories exist
    if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    if (!fs.existsSync(REPORT_ARCHIVE_DIR)) fs.mkdirSync(REPORT_ARCHIVE_DIR, { recursive: true });

    // Ensure essential JSON files exist to prevent Astro.glob or fs.readFileSync from failing
    if (!fs.existsSync(REPORTS_OUTPUT_PATH)) writeDataToFile(REPORTS_OUTPUT_PATH, []);
    if (!fs.existsSync(OUTPUT_FILE_PATH)) writeDataToFile(OUTPUT_FILE_PATH, []);
}
async function main() {
    console.log('--- Starting AI-Nexus Data Fetching Script ---');
    initializeDirectories();

    // 1. Fetch data from all sources
    const sourcesData = await Promise.all([
        fetchHuggingFaceData(),
        readCivitaiData(),
        fetchGitHubData(),
        fetchReplicateData(),
    ]);

    const allRawModels = sourcesData.flat();

    // 2. Filter out NSFW content
    const sfwModels = allRawModels.filter(model => !isNsfw(model));
    console.log(`- Filtered down to ${sfwModels.length} SFW models.`);

    // 3. Deduplicate and merge models
    const mergedModels = new Map();
    for (const model of sfwModels) {
        const key = getModelKey(model.name);
        if (mergedModels.has(key)) {
            // Merge logic
            const existing = mergedModels.get(key);
            existing.likes += model.likes;
            existing.downloads += model.downloads;
            existing.tags = [...new Set([...existing.tags, ...model.tags])]; // Merge and deduplicate tags
            existing.sources.push(...model.sources);
            // Prioritize description from Hugging Face or GitHub over others
            if (!existing.description.includes('from GitHub') && (model.description.includes('from GitHub') || model.sources.some(s => s.platform === 'Hugging Face'))) {
                existing.description = model.description;
            }
        } else {
            mergedModels.set(key, model);
        }
    }

    // 4. Convert map back to array and sort
    const finalModels = Array.from(mergedModels.values());
    finalModels.sort((a, b) => b.likes - a.likes);

    console.log(`- Merged models down to ${finalModels.length} unique entries.`);

    if (finalModels.length > 0) {
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const archiveFilePath = path.join(ARCHIVE_DIR, `${today}.json`);

        const combinedData = finalModels; // Use the final merged and sorted data
        
        // 1. Write to dated archive file
        writeDataToFile(archiveFilePath, combinedData);

        // 2. Write to the main models.json for the build process
        writeDataToFile(OUTPUT_FILE_PATH, combinedData);
        await writeToKV('models', JSON.stringify(combinedData));

        // 5. Discover and save hot keywords based on the final model list
        discoverAndSaveKeywords(combinedData); // <-- This now uses the new, improved logic

        // 6. Generate and save the AI weekly report
        const newReport = await generateAIWeeklyReport(combinedData);
        await updateReportsFile(newReport);
    } else {
        console.log('🔥 No data was fetched, skipping file write and KV update.');
        // Still run updateReportsFile with null to ensure the file is present for the build.
        await updateReportsFile(null);
    }
    console.log('--- ✅ Data fetching script finished successfully! ---');
}

main();
