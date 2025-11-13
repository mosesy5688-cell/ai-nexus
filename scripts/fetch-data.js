const axios = require('axios');
const fs = require('fs');
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

/**
 * Generates an AI summary for a model's README, with caching and cost-control.
 * @param {string | null} readmeText The README content.
 * @param {string} modelId The ID of the model for logging.
 * @param {object} currentModelData The existing model data to check for a cached summary.
 * @returns {Promise<string>} The AI-generated summary or a fallback.
 */
async function getAISummary(readmeText, modelId, currentModelData) {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;

  // 1. Caching: If a good summary already exists, reuse it.
  if (currentModelData?.summary_ai && currentModelData.summary_ai.length > 50) {
    console.log(`- Reusing existing AI summary for ${modelId}.`);
    return currentModelData.summary_ai;
  }

  // 2. Cost Control: If no README or it's too short, don't call the API.
  // Also, truncate the readme to a reasonable length to avoid overly long API calls.
  const truncatedReadme = (readmeText || '').substring(0, 8000);
  if (truncatedReadme.length < 500) {
    return truncatedReadme.substring(0, 250); // Return a simple truncated version
  }

  // 3. API Key Check: Only proceed if the API key is available.
  if (!GROQ_API_KEY) {
    console.warn(`- GROQ_API_KEY not found. Skipping AI summary for ${modelId}.`);
    return ''; // Return empty if no key
  }

  console.log(`- Generating AI summary for ${modelId}...`);

  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-70b-versatile', // Use a current, high-performance model
        messages: [
          {
            role: 'system',
            content: "You are a helpful assistant that creates concise summaries of AI models for a technical audience. Your summaries should be professional, clear, and highlight the model's core purpose and features.",
          },
          {
            role: 'user',
            content: `Based on the following README content, generate a professional summary of the model's purpose, key features, and ideal use case. The summary must be 100 words or less.\n\nREADME:\n"""\n${truncatedReadme}\n"""`,
          },
        ],
        temperature: 0.5,
        max_tokens: 150,
      },
      {
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const summary = response.data.choices[0]?.message?.content.trim() || '';
    console.log(`- AI summary generated for ${modelId}.`);
    return summary;

  } catch (error) {
    console.error(`❌ Failed to generate AI summary for ${modelId}:`, error.response?.data?.error?.message || error.message);
    return ''; // Return empty on failure
  }
}

/**
 * Generates a weekly AI report using the Groq API based on the latest models.
 * @param {Array<object>} models The list of recently fetched models.
 * @returns {Promise<object|null>} A report object or null on failure.
 */
async function generateAIWeeklyReport(models) {
    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_API_KEY) {
        console.warn('- GROQ_API_KEY not found. Skipping AI weekly report generation.');
        return null;
    }

    console.log('- Generating AI weekly report...');
    const latestModels = models.slice(0, 10).map(m => `- **${m.name}**: A popular model for ${m.task} with ${m.likes.toLocaleString()} likes.`).join('\n');

    try {
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: 'llama-3.1-70b-versatile',
                messages: [
                    {
                        role: 'system',
                        content: "You are an AI industry analyst. Your task is to write a concise, insightful weekly report on trends in the open-source AI model landscape, formatted in Markdown. The report should be engaging and around 250-350 words."
                    },
                    {
                        role: 'user',
                        content: `Based on the following list of trending open-source AI models, write a weekly report in Markdown format. Analyze any noticeable trends (e.g., a rise in specific model types, new popular tasks), mention one or two standout models with their key details, and conclude with a brief forward-looking statement.\n\n**Trending Models This Week:**\n${latestModels}`
                    }
                ],
                temperature: 0.7,
                max_tokens: 500,
            },
            { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
        );
        const reportContent = response.data.choices[0]?.message?.content.trim() || '';
        return { title: `AI Model Trends: Week of ${new Date().toLocaleDateString()}`, content: reportContent, date: new Date().toISOString() };
    } catch (error) {
        console.error(`❌ Failed to generate AI weekly report:`, error.response?.data?.error?.message || error.message);
        return null;
    }
}
/**
 * Generates a weekly AI report using the Groq API based on the latest models.
 * @param {Array<object>} models The list of recently fetched models.
 * @returns {Promise<void>}
 */
async function generateAIWeeklyReport(models) {
    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_API_KEY) {
        console.warn('- GROQ_API_KEY not found. Skipping AI weekly report generation.');
        return;
    }

    console.log('- Generating AI weekly report...');
    const latestModels = models.slice(0, 10).map(m => `- ${m.name} (Task: ${m.task}, Likes: ${m.likes})`).join('\n');

    try {
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: 'llama-3.1-70b-versatile',
                messages: [
                    {
                        role: 'system',
                        content: "You are an AI industry analyst. Your task is to write a concise, insightful weekly report on trends in the open-source AI model landscape. The report should be engaging and around 200-300 words."
                    },
                    {
                        role: 'user',
                        content: `Based on the following list of trending open-source AI models, write a weekly report. Analyze any noticeable trends (e.g., a rise in specific model types, new popular tasks, etc.), mention one or two standout models, and conclude with a brief forward-looking statement.

Trending Models This Week:
${latestModels}`
                    }
                ],
                temperature: 0.7,
                max_tokens: 400,
            },
            { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
        );
        const reportContent = response.data.choices[0]?.message?.content.trim() || '';
        return { title: `AI Model Trends: Week of ${new Date().toLocaleDateString()}`, content: reportContent, date: new Date().toISOString() };
    } catch (error) {
        console.error(`❌ Failed to generate AI weekly report:`, error.response?.data?.error?.message || error.message);
        return null;
    }
}
/**
 * Normalizes a model name to create a consistent key for deduplication.
 * @param {string} name The name of the model.
 * @returns {string} A normalized string.
 */

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
            let readmeContent = null;
            const currentModelData = existingModelsMap.get(model.modelId) || {};

            try {
                // Reuse existing readme if available to reduce fetches
                if (currentModelData.readme) {
                    readmeContent = currentModelData.readme;
                } else {
                    const readmeUrl = `https://huggingface.co/${model.modelId}/raw/main/README.md`;
                    const readmeResponse = await axios.get(readmeUrl);
                    readmeContent = readmeResponse.data;
                }
            } catch (e) {
                // It's okay if a README doesn't exist, we'll just skip it.
            }
            const aiSummary = await getAISummary(readmeContent, model.modelId, currentModelData);

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
                thumbnail: model.cardData?.image, // Add thumbnail from cardData
                summary_ai: aiSummary,
                sources: [{ platform: 'Hugging Face', url: `https://huggingface.co/${model.modelId}` }],
            });

            // Add a small delay to avoid hitting the rate limit so aggressively
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
        const transformedData = data.items.map(repo => ({
            id: `github-${repo.full_name.replace('/', '-')}`,
            name: repo.name,
            author: repo.owner.login,
            description: repo.description || 'An AI tool from GitHub.',
            task: 'tool', // Assign a default task for GitHub repos
            tags: repo.topics || [],
            likes: repo.stargazers_count,
            downloads: repo.watchers_count, // Using watchers as a proxy for downloads
            lastModified: repo.updated_at,
            readme: null, // GitHub READMEs are not fetched in this version
            sources: [{ platform: 'GitHub', url: repo.html_url }],
            thumbnail: repo.owner.avatar_url,
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
            thumbnail: model.images?.[0]?.url, // Use the first image as a thumbnail
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

async function updateReportsFile(newReport) {
    let reports = [];
    if (fs.existsSync(REPORTS_OUTPUT_PATH)) {
        try {
            reports = JSON.parse(fs.readFileSync(REPORTS_OUTPUT_PATH, 'utf-8'));
        } catch (e) {
            console.warn('Could not parse existing reports.json. Starting fresh.');
        }
    } else if (!newReport) {
        // CRITICAL FIX: If the report file doesn't exist and there's no new report,
        // create an empty file to prevent build errors.
        writeDataToFile(REPORTS_OUTPUT_PATH, []);
        return;
    }
    if (!newReport) return;
    reports.unshift(newReport); // Add new report to the beginning
    writeDataToFile(REPORTS_OUTPUT_PATH, reports.slice(0, 52)); // Keep latest 52 reports
}

async function updateReportsFile(newReport) {
    let reports = [];
    if (fs.existsSync(REPORTS_OUTPUT_PATH)) {
        try {
            reports = JSON.parse(fs.readFileSync(REPORTS_OUTPUT_PATH, 'utf-8'));
        } catch (e) {
            console.warn('Could not parse existing reports.json. Starting fresh.');
        }
    } else if (!newReport) {
        // CRITICAL FIX: If the report file doesn't exist and there's no new report,
        // create an empty file to prevent build errors.
        writeDataToFile(REPORTS_OUTPUT_PATH, []);
        return;
    }
    if (!newReport) return;
    reports.unshift(newReport); // Add new report to the beginning
    writeDataToFile(REPORTS_OUTPUT_PATH, reports.slice(0, 52)); // Keep latest 52 reports
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
    if (newReport) reports.unshift(newReport); // Add new report to the beginning
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
        // Still ensure the reports file exists to prevent build errors on subsequent runs.
        await updateReportsFile(null);
    }
    console.log('--- ✅ Data fetching script finished successfully! ---');
}

main();
