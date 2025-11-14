const axios = require('axios');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');

// --- Configuration ---
const CIVITAI_DATA_PATH = path.join(__dirname, '../src/data/civitai.json');
const HUGGINGFACE_API_URL = 'https://huggingface.co/api/models?sort=likes&direction=-1&limit=100';
const OUTPUT_FILE_PATH = path.join(__dirname, '../src/data/models.json');
const KEYWORDS_OUTPUT_PATH = path.join(__dirname, '../src/data/keywords.json');
const REPORTS_OUTPUT_PATH = path.join(__dirname, '../src/data/reports.json');
const ARCHIVE_DIR = path.join(__dirname, '../src/data/archives');
const REPORT_ARCHIVE_DIR = path.join(__dirname, '../src/data/report-archives');
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
const geminiModel = genAI ? genAI.getGenerativeModel({ model: 'gemini-1.5-pro-latest' }) : null;

/**
 * Builds the prompt for the AI weekly report generation.
 * @param {string} reportId - The ID for the report (YYYY-MM-DD).
 * @param {string} dateString - The formatted date string for the title.
 * @param {Array<string>} featuredModelIds - An array of featured model IDs.
 * @param {Array<object>} latestModels - A list of the latest models for context.
 * @returns {string} The complete prompt string.
 */
function buildReportPrompt(reportId, dateString, featuredModelIds, latestModels) {
    return `
    As an AI industry analyst, generate a weekly report on trends in the open-source AI model landscape based on the provided list of trending models. Your output MUST be a single, valid, parsable JSON string. Do not include any text or markdown formatting before or after the JSON block. The entire response should be only the JSON object.

    The JSON object must follow this exact structure:
    {
      "reportId": "YYYY-MM-DD",
      "title": "Weekly AI Model & Tech Report [Date]",
      "date": "YYYY-MM-DD",
      "summary": "A brief summary of this week's key AI advancements.",
      "sections": [{"heading": "Key Technology Breakthoughs", "content": "Markdown-formatted content...", "keywords": []}, {"heading": "Popular Product Applications & Market Trends", "content": "Markdown-formatted content...", "keywords": []}],
      "featuredModelIds": ["model-id-1", "model-id-2"]
    }

    Instructions:
    1.  Use '${reportId}' for "reportId" and "date".
    2.  The title must be "Weekly AI Model & Tech Report [Date]", where [Date] is replaced with "${dateString}".
    3.  The 'content' for each section must be detailed, insightful, and written in English using Markdown for formatting (e.g., **bold**, *italic*, links).
    4.  The 'featuredModelIds' array must contain exactly these two IDs: ${JSON.stringify(featuredModelIds)}.
    5.  Analyze the following trending models to inform your report: ${JSON.stringify(latestModels, null, 2)}
    `;
}

/**
 * Generates a weekly AI report using the Groq API based on the latest models.
 * @param {Array<object>} models The list of recently fetched models.
 * @returns {Promise<void>}
 */
async function generateAIWeeklyReport(models) { // <-- This function is being modified
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
    return null;
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
                    url: `https://huggingface.co/${model.modelId}`,
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
        const transformedData = civitaiData.map(model => ({
            id: `civitai-${model.name.toLowerCase().replace(/\s+/g, '-')}`,
            name: model.name,
            author: model.creator?.username || 'Civitai Community',
            description: model.description || 'An image generation model from Civitai.',
            task: 'image-generation', // Assume all are image generation for now
            tags: model.tags || [],
            likes: model.stats?.favoriteCount || 0,
            downloads: model.stats?.downloadCount || 0,
            lastModified: model.lastUpdate || new Date().toISOString(),
            readme: null, // Civitai READMEs are not fetched
            thumbnail: null, // Images are disabled
            downloadUrl: model.downloadUrl, // Assuming the JSON has this field
            sources: [{
                platform: 'Civitai',
                url: `https://civitai.com/models/${model.id}`,
                modelId: model.id,
                creator: model.creator?.username,
            }],
        }));
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

function discoverAndSaveKeywords(models) {
    console.log('Discovering hot keywords...');
    const tagFrequency = new Map();
    const excludedTags = new Set(['transformers', 'safetensors', 'pytorch', 'diffusers', 'en', 'license:mit', 'region:us', 'custom_code']);

    for (const model of models) {
        if (model.tags) {
            for (const tag of model.tags) {
                if (!excludedTags.has(tag) && !tag.includes(':') && tag.length > 2 && tag.length < 25) {
                    tagFrequency.set(tag, (tagFrequency.get(tag) || 0) + 1);
                }
            }
        }
    }

    const sortedTags = Array.from(tagFrequency.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12) // Get the top 12 hot keywords
        .map(entry => ({
            slug: entry[0],
            title: entry[0].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()), // Format title
            count: entry[1]
        }));

    writeDataToFile(KEYWORDS_OUTPUT_PATH, sortedTags);
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
        discoverAndSaveKeywords(combinedData);

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
