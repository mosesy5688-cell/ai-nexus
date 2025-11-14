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
 * Generates a weekly AI report using the Groq API based on the latest models.
 * @param {Array<object>} models The list of recently fetched models.
 * @returns {Promise<void>}
 */
async function generateAIWeeklyReport(models) { // <-- This function is being modified
    if (!geminiModel) {
        console.warn('- GEMINI_API_KEY not found. Skipping AI report generation and returning a placeholder.');
        return {
            reportId: new Date().toISOString().split('T')[0],
            title: "AI Report Generation Skipped",
            date: new Date().toISOString().split('T')[0],
            summary: "AI report generation was skipped because the GEMINI_API_KEY was not provided in the environment.",
            sections: [{
                heading: "Configuration Notice",
                content: "To enable AI-generated weekly reports, please add the `GEMINI_API_KEY` as an environment variable in your deployment settings.",
                keywords: ["configuration", "api-key-missing"]
            }],
            featuredModelIds: []
        };
    }

    console.log('- Generating AI weekly report...');
    const latestModels = models.slice(0, 15).map(m => ({ id: m.id, name: m.name, task: m.task, likes: m.likes, description: m.description.substring(0, 100) }));
    const featuredModelIds = latestModels.slice(0, 2).map(m => m.id);
    const today = new Date();
    const reportId = today.toISOString().split('T')[0];
    const dateString = today.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    const prompt = `
    As an AI industry analyst, generate a weekly report on trends in the open-source AI model landscape based on the provided list of trending models. Your output MUST be a single, valid, parsable JSON string. Do not include any text or markdown formatting before or after the JSON block. The entire response should be only the JSON object.

    The JSON object must follow this exact structure:
    {
      "reportId": "YYYY-MM-DD",
      "title": "Weekly AI Model & Tech Report [Date]",
      "date": "YYYY-MM-DD",
      "summary": "A brief summary of this week's key AI advancements.",
      "sections": [
        {
          "heading": "Key Technology Breakthoughs (e.g., New Transformer Architecture)",
          "content": "Markdown-formatted long-text content about the breakthroughs, their impact, and links to papers.",
          "keywords": ["Transformer", "Scaling Law"]
        },
        {
          "heading": "Popular Product Applications & Market Trends (e.g., Gemini 1.5 Pro Updates)",
          "content": "Markdown-formatted long-text content analyzing product updates, commercialization, and market response.",
          "keywords": ["Gemini", "Llama", "Commercialization"]
        }
      ],
      "featuredModelIds": ["model-id-1", "model-id-2"]
    }

    Instructions:
    1.  Use '${reportId}' for "reportId" and "date".
    2.  The title must be "Weekly AI Model & Tech Report [Date]", where [Date] is replaced with "${dateString}".
    3.  The 'content' for each section must be detailed, insightful, and written in English using Markdown for formatting (e.g., **bold**, *italic*, links).
    4.  The 'featuredModelIds' array must contain exactly these two IDs: ["${featuredModelIds[0]}", "${featuredModelIds[1]}"].
    5.  Analyze the following trending models to inform your report: ${JSON.stringify(latestModels, null, 2)}
    `;

    try {
        const result = await geminiModel.generateContent(prompt);
        const responseText = result.response.text().trim();
        
        // Clean the response to ensure it's a valid JSON string, removing markdown code blocks
        const jsonString = responseText.replace(/^```json\s*|```\s*$/g, '');
        
        // Validate and parse the JSON
        const report = JSON.parse(jsonString);
        
        // Final check for required fields
        if (report.reportId && report.title && report.sections) {
            console.log(`✅ AI weekly report generated successfully for ${reportId}.`);
            return report;
        } else {
            throw new Error("Generated JSON is missing required fields.");
        }
    } catch (error) {
        console.error(`❌ Failed to generate AI weekly report:`, error.message);
        // Return a placeholder/error report to ensure the file is not empty
        return {
            reportId: new Date().toISOString().split('T')[0],
            title: "AI Report Generation Failed",
            date: new Date().toISOString().split('T')[0],
            summary: "Could not generate the AI weekly report at this time. This may be due to an issue with the AI model provider or a missing API key. The service will attempt to generate it on the next cycle.",
            sections: [{
                heading: "API Error",
                content: `An error occurred while trying to generate the report: **${error.message}**. Please check the build logs and ensure the Gemini API is operational.`,
                keywords: ["error", "generation-failed"]
            }],
            featuredModelIds: []
        };
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getModelKey(name) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function fetchHuggingFaceData(existingModels) {
    console.log('📦 Fetching data from HuggingFace API...');
    const existingModelsMap = new Map(existingModels.map(m => [m.id, m]));

    try {
        const { data } = await axios.get(HUGGINGFACE_API_URL);
        const transformedData = [];
        for (const model of data) {
            let readmeContent = null, downloadUrl = null;
            const currentModelData = existingModelsMap.get(model.modelId) || {};

            try {
                if (currentModelData.readme) {
                    readmeContent = currentModelData.readme;
                } else {
                    const readmeUrl = `https://huggingface.co/${model.modelId}/raw/main/README.md`;
                    const readmeResponse = await axios.get(readmeUrl);
                    readmeContent = readmeResponse.data;
                    await sleep(50); // Small delay
                }

                // Attempt to find a direct download URL
                const files = model.siblings?.map(s => s.rfilename) || [];
                const safetensorFile = files.find(f => f.endsWith('.safetensors'));
                if (safetensorFile) {
                    downloadUrl = `https://huggingface.co/${model.modelId}/resolve/main/${safetensorFile}`;
                }

            } catch (e) {
                // It's okay if a README or other assets don't exist.
            }

            transformedData.push({
                id: model.modelId,
                name: model.modelId.split('/')[1] || model.modelId,
                author: model.author,
                description: model.cardData?.description || `A model for ${model.pipeline_tag || 'various tasks'}.`,
                task: model.pipeline_tag || 'N/A',
                tags: model.tags || [],
                likes: model.likes,
                downloads: model.downloads,
                lastModified: model.lastModified,
                readme: readmeContent,
                thumbnail: null, // Images are disabled
                downloadUrl: downloadUrl,
                sources: [{ platform: 'Hugging Face', url: `https://huggingface.co/${model.modelId}` }],
            });

            // Add a small delay to avoid hitting rate limits so aggressively
            await sleep(200); // 200ms delay between each summary generation
        }
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
            let readmeContent = null, downloadUrl = null;
            try {
                // Fetch README content
                const readmeUrl = `https://api.github.com/repos/${repo.full_name}/readme`;
                const readmeResponse = await axios.get(readmeUrl, {
                    headers: { 'Accept': 'application/vnd.github.raw' }
                });
                readmeContent = readmeResponse.data;

                // Use the releases URL as a proxy for downloads
                downloadUrl = `${repo.html_url}/releases`; // <-- This line is being modified
            } catch (e) {
                // It's okay if a README doesn't exist or fetch fails
                console.warn(`- Could not fetch README for ${repo.full_name}`);
            }

            return {
                id: `github-${repo.full_name.replace('/', '-')}`,
                name: repo.name,
                author: repo.owner.login,
                description: repo.description || 'An AI tool from GitHub.',
                task: 'tool', // Assign a default task for GitHub repos
                tags: repo.topics || [],
                likes: repo.stargazers_count,
                downloads: repo.watchers_count, // Using watchers as a proxy for downloads
                lastModified: repo.updated_at,
                readme: readmeContent,
                downloadUrl: downloadUrl,
                sources: [{ platform: 'GitHub', url: repo.html_url }], // <-- This line is being modified
                thumbnail: null, // Images are disabled
            };
        }));

        console.log(`✅ Successfully fetched and transformed ${transformedData.length} models from GitHub.`);
        return transformedData;
    } catch (error) {
        console.error('❌ Failed to fetch data from GitHub:', error.message);
        if (error.response) {
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
            sources: [{ platform: 'Civitai', url: `https://civitai.com/models/${model.id}` }],
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
    reports.unshift(newReport); // Add new report to the beginning
  }
  writeDataToFile(REPORTS_OUTPUT_PATH, reports.slice(0, 52)); // Keep latest 52 reports
}
async function main() {
    console.log('--- Starting AI-Nexus Data Fetching Script ---');
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const archiveFilePath = path.join(ARCHIVE_DIR, `${today}.json`);

    // Read existing models to enable caching for AI summaries
    let existingModels = [];
    if (fs.existsSync(OUTPUT_FILE_PATH)) {
        try {
            existingModels = JSON.parse(fs.readFileSync(OUTPUT_FILE_PATH, 'utf-8'));
        } catch (e) {
            console.warn('Could not parse existing models.json. Proceeding without cache.');
        }
    }
    
    // CRITICAL: Ensure reports.json exists before the build starts.
    if (!fs.existsSync(REPORTS_OUTPUT_PATH)) writeDataToFile(REPORTS_OUTPUT_PATH, []);

    // 1. Fetch data from all sources
    const sourcesData = await Promise.all([
        fetchHuggingFaceData(existingModels),
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
        if (newReport) await updateReportsFile(newReport);
    } else {
        console.log('🔥 No data was fetched, skipping file write and KV update.');
        // Still ensure the reports file exists to prevent build errors.
        await updateReportsFile(null);
    }
    console.log('--- ✅ Data fetching script finished successfully! ---');
}

main();
