import axios from 'axios';
import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';
import path from 'path';
import cheerio from 'cheerio';
import { fileURLToPath } from 'url';
import { fetchPwCData } from './fetch-pwc.js';

// --- Configuration ---_
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG = {
    HUGGINGFACE_API_BASE_URL: 'https://huggingface.co/api/models?sort=likes&direction=-1&limit=100&filter=text-generation,llm&modelType=model',
    GITHUB_SEARCH_QUERY: '"llm" OR "agent" OR "generative-ai"',
    OUTPUT_FILE_PATH: path.join(__dirname, '../src/data/models.json'),
    CATEGORIES_PATH: path.join(__dirname, '../src/data/categories.json'),
    KEYWORDS_OUTPUT_PATH: path.join(__dirname, '../src/data/keywords.json'),
    REPORTS_OUTPUT_PATH: path.join(__dirname, '../src/data/reports.json'),
    SEARCH_INDEX_PATH: path.join(__dirname, '../public/data/search-index.json'),
    RANKINGS_PATH: path.join(__dirname, '../public/data/rankings.json'),
    ARCHIVE_DIR: path.join(__dirname, '../src/data/archives'),
    REPORT_ARCHIVE_DIR: path.join(__dirname, '../src/data/report-archives'),
    NSFW_KEYWORDS: [
        'nsfw', 'porn', 'sexy', 'explicit', 'erotic', 'nude', 'naked', 'adult'
    ],
    KEYWORD_MERGE_MAP: {
        'gpt-4': 'gpt', 'chatgpt': 'gpt', 'chat': 'general-dialogue-qa', 'chatbot': 'general-dialogue-qa',
        'conversational': 'general-dialogue-qa', 'summarization': 'summarization-extraction',
        'translation': 'translation-localization', 'code': 'code-generation-assistance', 'coding': 'code-generation-assistance',
        'llms': 'llm', 'agent': 'agents', 'ai-agents': 'agents', 'large-language-model': 'large-language-models',
        'prompts': 'prompt', 'tools': 'tool', 'image-generation': 'image-generation', 'text-to-image': 'image-generation',
        'video-generation': 'video-generation-editing', 'text-to-video': 'video-generation-editing',
        'rag': 'rag-knowledge-base-qa', 'retrieval-augmented-generation': 'rag-knowledge-base-qa'
    },
    MINIMUM_MODEL_THRESHOLD_PERCENTAGE: 0.8,
};

// NEW: Load the GitHub Token
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const GITHUB_HEADERS = {
    'Accept': 'application/vnd.github.v3+json',
    ...(GITHUB_TOKEN && { 'Authorization': `Bearer ${GITHUB_TOKEN}` })
};

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
function buildReportPrompt(reportId, dateRange, currentDateFormatted, startDate, endDate, latestModels, keywords) {
    const reportPrompt = `
**[PERSONA DEFINITION & TONE]**
You are a Senior AI Industry Analyst working for **Free AI Tools**, a high-authority platform tracking the open-source AI sector. Your tone must be strictly objective, professional, analytical, and forward-looking.

**[CRITICAL TIME CONTEXT]**
The current date is **${currentDateFormatted}**. The report's analysis period is the **two-week period from ${startDate} to ${endDate}**. Your external citations MUST prioritize news and data released within the last 14 days.

**[DATA INTEGRITY CONSTRAINTS - STRICTLY MANDATORY]**
1. **NO FABRICATION:** You **MUST NOT** invent or fabricate any model names, statistics, market trends, policy news, or industry events. All data and cases must be grounded ONLY in the provided internal data (Composite Score derived) or verified external search results.
2. **CITATION MANDATE:** You **MUST** output a final, separate section titled "**References and Source Notes**" at the absolute end of the report content.
3. **STRICT RECENCY AND SOURCE AUTHORITY REQUIREMENT:**
    * **RECENCY:** You are strictly forbidden from citing any major event or policy from the year 2024 or earlier. All external data MUST be current (post-September 2025).
    * **AUTHORITY MANDATE:** When analyzing macro trends (Section 4 & 5), your analysis MUST ONLY be grounded by, and must explicitly cite, one of the following authority types:
        a. **Official AI Lab Announcements:** (e.g., OpenAI Blog, Google DeepMind Post, Anthropic Updates).
        b. **Tier-1 Financial/Policy News:** (e.g., Bloomberg, Reuters, Financial Times, WSJ).
        c. **Peer-Reviewed Research:** (e.g., Arxiv, ICLR, NeurIPS, Nature, Science).
    * If your Google Search tool cannot find a recent (post-September 2025) source from these authorized categories, you **MUST omit the claim** rather than using a low-reputation or old source.

**[OUTPUT FORMAT & STRUCTURE CONSTRAINT]**
The entire report MUST be structured using the following five Markdown headings, in this exact order. Ensure the analysis is deep and professionally written.

# Free AI Tools Bi-Weekly Industry Analysis Report - ${dateRange}

## 1. Executive Summary
(1-2 concise paragraphs summarizing the two-week period's key takeaways, focusing on the convergence of open-source activity with macro trends.)

## 2. Model Performance Movers: The Top Gainers (Internal Data Analysis)
Analyze the 10 models with the highest **bi-weekly** growth rate (BIG_MOVERS). Explain *why* these projects are surging, linking the spike to new features or external adoption.
**[NEW INSTRUCTION for Structured Data]** The analysis MUST conclude with a **"Key Growth Data"** section, presented as a clear Markdown table or bulleted list, detailing the Top 5 models by percentage growth and their absolute Composite Quality Score increase this bi-weekly period.

## 3. New Tech Breakthroughs & Rising Stars (Internal Data Analysis)
Analyze the 10 most influential new models (NEW_STARS) that entered the list this bi-weekly period, filtered by the Composite Quality Score. Identify the new technology, application, or architecture (e.g., MoE, new RAG technique, novel quantization) they introduce.
**[NEW INSTRUCTION for Structured Data]** Conclude this section with a **"Technology Adoption Summary"**, presented as a Markdown list, identifying the top 3 emerging technologies and listing the models associated with each.

## 4. Market Trend Analysis (Internal & External Data Fusion)
**[INSTRUCTION]** Analyze the significance of the Top Keywords. Connect these open-source keywords to **recent macro market announcements, venture capital trends, or major closed-source model updates**. Use external search results to substantiate your claims, and briefly mention the source in the text (e.g., "Bloomberg reported...").

## 5. Analyst Commentary & Outlook (External Data Grounding)
**[INSTRUCTION]** Provide a forward-looking outlook for the next two weeks. This commentary MUST be grounded in **observed policy changes, major upcoming industry events, or confirmed funding rounds/acquisitions**. Conclude with a clear statement on the *market direction* for developers and investors.

---
# References and Source Notes
(A final, mandatory section containing all external sources.)

**[FORMAT REQUIREMENT]:** For every piece of external information, provide a full, hyperlinked Markdown citation.
* **General External Source Format:** \`[Title of Article/Source (Platform/Outlet)] (Full URL of Source)\`
* **Academic Paper Source Format:** For any papers, you MUST include the DOI or a direct, full link. \`[Paper Title (ArXiv/Journal)] (Full URL) DOI: xxx\`
`;
    const risingStars = latestModels.filter(m => m.is_rising_star).slice(0, 10);
    const bigMovers = latestModels.sort((a, b) => b.velocity - a.velocity).slice(0, 10);

    const dataSection = `
**[INPUT DATA - PROVIDED BY FREE AI TOOLS PLATFORM]**
* **BIG_MOVERS (Top 10 by Velocity Score):** ${JSON.stringify(bigMovers, null, 2)}
* **NEW_STARS (Top 10 Rising Stars):** ${JSON.stringify(risingStars, null, 2)}
* **Top Keywords:** ${JSON.stringify(keywords.slice(0, 10), null, 2)}
`;
    return (reportPrompt + dataSection);
}

/**
 * Post-processes the AI-generated report to link model names and keywords to internal pages.
 * @param {string} reportContent - The raw markdown content of the report.
 * @param {Array<object>} allModels - The list of all models.
 * @param {Array<object>} allKeywords - The list of all validated keywords.
 * @returns {string} The report content with entities linked.
 */
function linkEntitiesInReport(reportContent, allModels, allKeywords) {
    console.log('- Linking entities within the report...');
    let linkedContent = reportContent;

    // Sort models by name length, descending, to avoid partial matches (e.g., "Llama-3" before "Llama-3-8B")
    const sortedModels = [...allModels].sort((a, b) => b.name.length - a.name.length);

    // Link models
    sortedModels.forEach(model => {
        const slug = model.id.replace(/\//g, '--');
        const modelLink = `${model.name}`;
        // Use a regex to replace the model name only if it's not already part of a link.
        // This looks for the model name as a whole word (\b) and ensures it's not followed by "](/model/"
        // which would indicate it's already linked to a model page.
        const regex = new RegExp(`\\b${escapeRegExp(model.name)}\\b(?!(\\]\\(\\/model\\/)|(\\s*\\-))`, 'gi');
        linkedContent = linkedContent.replace(regex, modelLink);
    });

    // Link keywords
    allKeywords.forEach(keyword => {
        const keywordLink = `${keyword.title}`;
        // Use a regex to replace the keyword title (case-insensitive) as a whole word,
        // and ensure it's not already part of a link.
        const regex = new RegExp(`\\b${escapeRegExp(keyword.title)}\\b(?!(\\]\\(\\/explore\\?tag=))`, 'gi');
        linkedContent = linkedContent.replace(regex, keywordLink);
    });

    return linkedContent;
}

/**
 * Escapes special characters in a string for use in a regular expression.
 * @param {string} str The string to escape.
 * @returns {string} The escaped string.
 */
function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

/**
 * Generates a weekly AI report using the Gemini API based on the latest models.
 * This function now checks if 14 days have passed since the last report.
 * @param {Array<object>} models The list of recently fetched models.
 * @returns {Promise<object|null>} The new report object if generated, otherwise null.
 */
async function generateBiWeeklyReport(models, keywords) {
    const BI_WEEKLY_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000;
    console.log("- Checking if a bi-weekly report is due...");

    // 1. Load the reports metadata file
    let lastReportDate = null;
    if (fs.existsSync(CONFIG.REPORTS_OUTPUT_PATH)) {
        try {
            const existingReports = JSON.parse(fs.readFileSync(CONFIG.REPORTS_OUTPUT_PATH, 'utf-8'));
            if (existingReports.length > 0) {
                lastReportDate = new Date(existingReports[0].date);
            }
        } catch (e) {
            console.warn('- Could not parse existing reports.json. Proceeding to generate a new report.');
        }
    }

    const now = new Date();
    if (lastReportDate) {
        const timeSinceLastReport = now.getTime() - lastReportDate.getTime();
        if (timeSinceLastReport < BI_WEEKLY_INTERVAL_MS) {
            const daysRemaining = Math.ceil((BI_WEEKLY_INTERVAL_MS - timeSinceLastReport) / (1000 * 60 * 60 * 24));
            console.log(`✅ Bi-weekly report skipped. Next report due in approximately ${daysRemaining} days.`);
            return null; // Indicate that no report was generated
        }
    }

    console.log("📦 14 days elapsed or no previous report found. Generating new bi-weekly report...");

    if (!geminiModel) {
        console.warn('- GEMINI_API_KEY not found. Skipping AI report generation.');
        return null;
    }

    if (models.length < 2) {
        console.warn('- Not enough models (< 2) to generate a weekly report. Skipping.');
        return null;
    }

    const latestModels = models.slice(0, 15).map(m => ({ id: m.id, name: m.name, task: m.task, likes: m.likes, description: m.description.substring(0, 100) }));
    
    // --- Dynamic Date Calculation for Prompt (CRITICAL) ---
    const endDateObj = new Date();
    const startDateObj = new Date(endDateObj.getTime() - 14 * 24 * 60 * 60 * 1000);

    const endDate = endDateObj.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const startDate = startDateObj.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const dateRange = `${startDate} - ${endDate}`;
    const currentDateFormatted = endDateObj.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const reportId = endDateObj.toISOString().split('T')[0];

    const prompt = buildReportPrompt(reportId, dateRange, currentDateFormatted, startDate, endDate, latestModels, keywords);

    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const result = await geminiModel.generateContent(prompt);
            const responseText = result.response.text().trim();
            
            // Simple validation for the new Markdown format
            if (responseText.includes('# Free AI Tools Bi-Weekly Industry Analysis Report') && responseText.includes('## 1. Executive Summary')) {
                console.log(`✅ AI weekly report generated successfully for ${reportId} on attempt ${attempt}.`);
                
                // --- NEW: Link entities in the report content ---
                const linkedContent = linkEntitiesInReport(responseText, models, keywords);
                // --- END NEW ---

                // Extract title and summary from the markdown content
                const titleMatch = linkedContent.match(/^#\s*(.*)/m);
                const summaryMatch = linkedContent.match(/##\s*1\.\s*Executive Summary\s*\n+([\s\S]*?)\n##/);

                const report = {
                    reportId: reportId,
                    title: titleMatch ? titleMatch[1].trim().replace('[Date Range]', dateRange) : `Free AI Tools Bi-Weekly Report - ${dateRange}`,
                    date: reportId,
                    summary: summaryMatch ? summaryMatch[1].trim().substring(0, 300) + '...' : "A bi-weekly analysis of the open-source AI landscape.",
                    content: linkedContent, // Store the new, linked markdown content
                    featuredModelIds: [], // This can be populated later if needed
                    tags: ["bi-weekly-report", "ai-trends", "industry-analysis"]
                };
                return report;
            } else {
                throw new Error("Generated report is missing required structure.");
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
      title: `Free AI Tools Bi-Weekly Report - ${dateRange}`,
      date: reportId,
      summary: "This week's AI-generated analysis is temporarily unavailable. In the meantime, explore the top models that have been trending in the community.",
      content: `# Fallback Report\n\nOur AI analyst is currently unavailable. Here are this week's top models:\n\n${latestModels.map(m => `- **${m.name}**: ${m.description}`).join('\n')}`,
      featuredModelIds: [],
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
        // NEW: Merge default config with GITHUB_HEADERS for READMEs
        const fetchConfig = {
            ...config,
            headers: {
                ...config.headers,
                // Apply GitHub token headers (especially for vnd.github.raw)
                ...(GITHUB_TOKEN && { 'Authorization': `Bearer ${GITHUB_TOKEN}` })
            }
        };
        const response = await axios.get(url, fetchConfig);
        return response.data;
    } catch (error) {
        // It's okay if a README doesn't exist.
        return null;
    }
}

/**
 * Fetches and transforms data from the HuggingFace API.
 * @returns {Promise<Array<object>>} A promise that resolves to an array of transformed model data.
 */async function fetchHuggingFaceData() {
    console.log('📦 Fetching data from HuggingFace API (up to 5 pages)...');
    const allModels = [];
    const MAX_PAGES = 5;
    try {
        const pagePromises = Array.from({ length: MAX_PAGES }, (_, i) =>
            axios.get(`${CONFIG.HUGGINGFACE_API_BASE_URL}&page=${i}`, { timeout: 20000 }).catch(e => {
                console.error(`- Failed to fetch page ${i} from HuggingFace:`, e.message);
                return { data: [] }; // Return empty data on error to not break Promise.all
            })
        );

        const responses = await Promise.all(pagePromises);
        for (const response of responses) {
            if (response.data && response.data.length > 0) {
                allModels.push(...response.data);
            }
        }

        const transformedData = await Promise.all(allModels.map(model => transformHuggingFaceModel(model)));

        console.log(`✅ Successfully fetched and transformed ${transformedData.length} models.`);
        return transformedData;
    } catch (error) {
        console.error('❌ Failed to fetch data from HuggingFace API:', error.message);
        if (error.response) {
            console.error(`    - Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data).substring(0, 100)}...`);
        }
        return []; // Return empty on error to avoid breaking the build
    }
}

/**
 * Transforms a single HuggingFace model item into our standard format.
 * @param {object} model - The HuggingFace model item.
 * @returns {Promise<object>}
 */
async function transformHuggingFaceModel(model) {
    const readmeUrl = `https://huggingface.co/${model.modelId}/raw/main/README.md`;
    const readmeContent = await fetchReadme(readmeUrl);

    const files = model.siblings?.map(s => s.rfilename) || [];
    const safetensorFile = files.find(f => f.endsWith('.safetensors'));
    const modelUrl = `https://huggingface.co/${model.modelId}`;
    const downloadUrl = safetensorFile ? `https://huggingface.co/${model.modelId}/resolve/main/${safetensorFile}` : null;

    const fileDetails = (model.siblings || []).map(s => ({ name: s.rfilename, size: s.sizeInBytes })).filter(f => !f.name.startsWith('.'));

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
        lastModifiedTimestamp: new Date(model.lastModified).getTime(),
        readme: readmeContent,
        downloadUrl: downloadUrl,
        sources: [{
            platform: 'Hugging Face',
            url: modelUrl,
            files: fileDetails, // Add file list
            author: model.author,
            modelId: model.modelId,
        }],
        thumbnail: null,
    };
}

/**
 * Fetches and transforms data from GitHub API.
 * Can be augmented with a list of specific repository URLs to fetch.
 * @param {string[]} [additionalRepoUrls=[]] - An array of specific GitHub repo URLs to fetch.
 * @returns {Promise<Array<object>>}
 */
async function fetchGitHubData(additionalRepoUrls = []) {
    console.log('📦 Fetching data from GitHub API...');

    const fetchedRepos = new Set();
    const allTransformedData = [];
    const reposToProcess = [];
    const MAX_PAGES = 5;

    try {
        // 1. Fetch from the general search query with pagination
        const encodedQuery = encodeURIComponent(CONFIG.GITHUB_SEARCH_QUERY);
        const GITHUB_API_BASE_URL = `https://api.github.com/search/repositories?q=${encodedQuery}&sort=stars&order=desc&per_page=100`;

        for (let page = 1; page <= MAX_PAGES; page++) {
            try {
                const { data } = await axios.get(`${GITHUB_API_BASE_URL}&page=${page}`, {
                    timeout: 20000,
                    headers: GITHUB_HEADERS // Use the defined headers
                });
                if (data.items && data.items.length > 0) {
                    reposToProcess.push(...data.items);
                } else {
                    break; // No more items, stop paginating
                }
            } catch (pageError) {
                console.error(`- Failed to fetch page ${page} from GitHub:`, pageError.message);
                break; // Stop on error
            }
        }

        // 2. Fetch specific repos from PapersWithCode
        if (additionalRepoUrls.length > 0) {
            console.log(`- Fetching details for ${additionalRepoUrls.length} repos from Papers with Code...`);
            const pwcRepoPromises = additionalRepoUrls.map(async (url) => {
                const repoFullName = url.replace('https://github.com/', '');
                try {
                    const response = await axios.get(`https://api.github.com/repos/${repoFullName}`, {
                        timeout: 5000,
                        headers: GITHUB_HEADERS // Use the defined headers
                    });
                    return response.data;
                } catch (err) {
                    console.error(`- Failed to fetch ${repoFullName}: ${err.message}`);
                    return null;
                }
            });
            const pwcRepos = (await Promise.all(pwcRepoPromises)).filter(Boolean);
            reposToProcess.unshift(...pwcRepos); // Prioritize PwC repos
        }

        // Deduplicate repos before processing details
        const uniqueRepos = Array.from(new Map(reposToProcess.map(repo => [repo.id, repo])).values());

        const processingPromises = uniqueRepos.map(repo => transformGitHubRepo(repo));

        const transformedRepos = await Promise.all(processingPromises);

        transformedRepos.forEach((repoData) => {
            if (repoData && !fetchedRepos.has(repoData.id)) {
                allTransformedData.push(repoData);
                fetchedRepos.add(repoData.id);
            }
        });

        console.log(`✅ Successfully fetched and transformed ${allTransformedData.length} unique models from GitHub.`);
        return allTransformedData;
    } catch (error) {
        console.error('❌ An error occurred during GitHub data fetch:', error.message);
        // NEW: Specifically check for rate limit errors (403 or 429) and return collected data
        if (error.response && (error.response.status === 403 || error.response.status === 429)) {
            const remaining = error.response.headers['x-ratelimit-remaining'];
            const resetTime = new Date(error.response.headers['x-ratelimit-reset'] * 1000).toLocaleTimeString();
            console.error(`    - CRITICAL: GitHub API rate limit reached! Remaining: ${remaining}, Resets at: ${resetTime}`);
            console.log(`- Returning ${allTransformedData.length} models fetched before rate limit.`);
            // Return the partially collected data to avoid losing progress
            return allTransformedData;
        }
        // For all other errors, return empty array
        return []; 
    }
}

/**
 * Transforms a single GitHub repository item into our standard model format.
 * @param {object} repo - The GitHub repository item.
 * @returns {Promise<object|null>}
 */
async function transformGitHubRepo(repo) {
    let readmeContent = null;
    try {
        readmeContent = await fetchReadme(`https://api.github.com/repos/${repo.full_name}/contents/README.md`, { headers: { 'Accept': 'application/vnd.github.raw' } });
    } catch (e) {
        readmeContent = await fetchReadme(`https://api.github.com/repos/${repo.full_name}/contents/readme.md`, { headers: { 'Accept': 'application/vnd.github.raw' } });
    }

    let description = repo.description || 'An AI tool from GitHub.';
    // If description is generic or empty, try to extract one from the README
    if ((!repo.description || repo.description.length < 20) && readmeContent) {
        const firstLines = readmeContent.split('\n').filter(line => line.trim().length > 10 && !line.trim().startsWith('#')).slice(0, 2).join(' ');
        if (firstLines.length > 20) {
            description = firstLines.substring(0, 250) + '...';
        }
    }

    return {
        id: `github-${repo.full_name.replace('/', '-')}`,
        name: repo.name,
        author: repo.owner.login,
        description: description,
        task: 'tool', // Assign a default task for GitHub repos
        tags: repo.topics || [],
        likes: repo.stargazers_count || 0,
        downloads: repo.watchers_count || 0, // Using watchers as a proxy for downloads
        lastModified: repo.updated_at,
        lastModifiedTimestamp: new Date(repo.updated_at).getTime(),
        readme: readmeContent,
        downloadUrl: null,
        sources: [{
            platform: 'GitHub',
            url: repo.html_url,
            // Add more GitHub specific details
            homepage: repo.homepage,
            language: repo.language,
            forks: repo.forks_count,
            open_issues: repo.open_issues_count,
            license: repo.license ? repo.license.name : 'No license',
        }],
        thumbnail: repo.owner.avatar_url || null,
    };
}
/**
 * Calculates a velocity score for a model to identify "rising stars".
 * @param {object} model - The model data.
 * @returns {number} The velocity score.
 */
function calculateVelocity(model) {
    const now = new Date();
    const createdAt = new Date(model.lastModified); // Using lastModified as a proxy for creation/update time
    const ageInDays = Math.max((now - createdAt) / (1000 * 60 * 60 * 24), 1); // Avoid division by zero, minimum 1 day

    const likes = model.likes || 0;
    const downloads = model.downloads || 0;

    // Simple velocity score: likes per day. Add a small weight for downloads.
    // This prioritizes recent, high-traction projects.
    const velocity = (likes / ageInDays) + (downloads / ageInDays / 10); // Downloads are weighted less

    return velocity;
}


/**
 * Writes data to a local file and ensures the directory exists.
 * @param {string} filePath - The path to the file.
 * @param {any} data - The data to write.
 */
function writeDataToFile(filePath, data) {
    console.log(`- Writing data to: ${path.basename(filePath)}`);
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
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
            await axios.put(url, value, { headers: { 'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' } });
            console.log(`✅ Successfully wrote data for key: "${key}" to Cloudflare KV.`);
        } catch (error) {
            console.error('❌ Failed to write data to Cloudflare KV:', error.response ? error.response.data : error.message);
            process.exit(1);
        }
    }
}
function isNsfw(model) {
    const name = model.name.toLowerCase();
    const description = (model.description || '').toLowerCase();
    const tags = (model.tags || []).map(t => t.toLowerCase());

    for (const keyword of CONFIG.NSFW_KEYWORDS) {
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
 * @returns {Array<object>} The array of validated keywords.
 */
function discoverAndSaveKeywords(models) {
    console.log('- Counting models for predefined categories...');

    // 1. Load the new categories as the source of truth for keywords.
    const categories = JSON.parse(fs.readFileSync(CONFIG.CATEGORIES_PATH, 'utf-8'));
    const categoryKeywords = {};
    categories.forEach(group => {
        group.items.forEach(item => {
            categoryKeywords[item.slug] = { ...item, count: 0 };
        });
    });

    const keywordMergeMap = CONFIG.KEYWORD_MERGE_MAP;

    // 2. Normalize model tags and count models for each category.
    models.forEach(model => {
        const modelTags = new Set((model.tags || []).map(tag => keywordMergeMap[tag] || tag));
        for (const tag of modelTags) {
            if (categoryKeywords[tag]) {
                categoryKeywords[tag].count++;
            }
        }
    });

    // 3. Filter out categories with no models and sort by count.
    const validatedKeywords = Object.values(categoryKeywords).filter(cat => cat.count > 0);

    // Final sort by count to display the most frequent ones first on the UI if needed.
    validatedKeywords.sort((a, b) => b.count - a.count);

    writeDataToFile(CONFIG.KEYWORDS_OUTPUT_PATH, validatedKeywords);
    console.log(`✅ Counted models for ${validatedKeywords.length} categories.`);
    return validatedKeywords;
}

/**
 * Assigns predefined category tags to models based on their existing tags and description.
 * @param {Array<object>} models - The list of all models.
 * @param {Array<object>} categories - The list of all categories from categories.json.
 * @returns {Array<object>} The models array with assigned category tags.
 */
function assignTagsToModel(models, categories) {
    console.log('- Assigning category tags to models...');
    const categoryKeywords = new Map();
    categories.flatMap(g => g.items).forEach(cat => {
        categoryKeywords.set(cat.slug.toLowerCase(), cat.slug);
        categoryKeywords.set(cat.title.toLowerCase(), cat.slug);
    });

    models.forEach(model => {
        const modelTags = new Set(model.tags || []);
        const description = (model.description || '').toLowerCase();

        // Match model's existing tags with category slugs/titles
        modelTags.forEach(tag => {
            if (categoryKeywords.has(tag.toLowerCase())) {
                modelTags.add(categoryKeywords.get(tag.toLowerCase()));
            }
        });

        // Match description with category titles
        for (const [title, slug] of categoryKeywords.entries()) {
            if (description.includes(title)) {
                modelTags.add(slug);
            }
        }
        model.tags = Array.from(modelTags);
    });
    console.log('✅ Finished assigning category tags.');
    return models;
}

/**
 * Reads existing reports, adds a new one, and writes back to the file.
 * Ensures the file exists to prevent build errors.
 * @param {object | null} newReport The new report to add.
 */
async function updateReportsFile(newReport) {
  if (newReport) {
    console.log(`- New report generated for ${newReport.reportId}. Updating report files...`);
    let reports = [];
    if (fs.existsSync(CONFIG.REPORTS_OUTPUT_PATH)) {
      try {
        reports = JSON.parse(fs.readFileSync(CONFIG.REPORTS_OUTPUT_PATH, 'utf-8'));
      } catch (e) {
        console.warn('Could not parse existing reports.json. Starting fresh.');
      }
    }

    // Long-term archival: Save the new report as a separate file
    const reportArchivePath = path.join(CONFIG.REPORT_ARCHIVE_DIR, `${newReport.reportId}.json`);
    console.log(`- Saving report to long-term archive: ${reportArchivePath}`);
    writeDataToFile(reportArchivePath, newReport);

    // Main reports file: Add new report to the beginning
    reports.unshift(newReport); // Add new report to the beginning
    const slicedReports = reports.slice(0, 52);
    console.log(`- Updating main reports file with ${slicedReports.length} most recent reports.`);
    // Keep only the latest 52 reports for the main page to ensure performance
    writeDataToFile(CONFIG.REPORTS_OUTPUT_PATH, slicedReports);
  } else {
    console.log('✅ No new report generated. Skipping reports file update.');
  }
}

/**
 * Initializes necessary directories and empty data files to prevent build errors.
 */
function initializeDirectories() {
    console.log('- Initializing required directories and files...');
    // Ensure data directories exist
    if (!fs.existsSync(CONFIG.ARCHIVE_DIR)) fs.mkdirSync(CONFIG.ARCHIVE_DIR, { recursive: true });
    if (!fs.existsSync(CONFIG.REPORT_ARCHIVE_DIR)) fs.mkdirSync(CONFIG.REPORT_ARCHIVE_DIR, { recursive: true });

    // Ensure essential JSON files exist to prevent Astro.glob or fs.readFileSync from failing
    if (!fs.existsSync(CONFIG.REPORTS_OUTPUT_PATH)) writeDataToFile(CONFIG.REPORTS_OUTPUT_PATH, []);
    if (!fs.existsSync(CONFIG.OUTPUT_FILE_PATH)) writeDataToFile(CONFIG.OUTPUT_FILE_PATH, []);
}

/**
 * Creates a lightweight search index from the final models data.
 * This index is used by the client-side search (Fuse.js) for better performance.
 * @param {Array<object>} models - The array of all model objects.
 */
function createSearchIndex(models) {
    console.log('- Creating search index...');
    const searchIndex = models.map(model => ({
        id: model.id,
        name: model.name,
        author: model.author,
        description: model.description,
        tags: model.tags || [],
        likes: model.likes || 0,
        downloads: model.downloads || 0,
        is_rising_star: model.is_rising_star || false,
    }));

    writeDataToFile(CONFIG.SEARCH_INDEX_PATH, searchIndex);
    console.log(`✅ Search index created with ${searchIndex.length} models.`);
}

/**
 * Generates and saves various rankings based on model data.
 * @param {Array<object>} models - The array of all model objects.
 * @param {Array<object>} keywords - The array of top keywords.
 */
function generateAndSaveRankings(models, keywords) {
    console.log('- Generating model rankings...');
    const activeModels = models.filter(m => !m.is_archived);

    // --- START: Generate Rankings ---
    // Hot Ranking (by likes)
    const hotRanking = [...activeModels]
      .sort((a, b) => (b.likes || 0) - (a.likes || 0))
      .slice(0, 100);

    // Trending Ranking (by downloads)
    const trendingRanking = [...activeModels]
      .sort((a, b) => (b.downloads || 0) - (a.downloads || 0))
      .slice(0, 100);

    // Newest Ranking (by creation date)
    const newestRanking = [...activeModels]
      .sort((a, b) => (b.lastModifiedTimestamp || 0) - (a.lastModifiedTimestamp || 0))
      .slice(0, 100);

    // Rising Star Ranking (by velocity)
    const risingStarRanking = activeModels
      .filter(m => m.is_rising_star)
      .sort((a, b) => (b.velocity || 0) - (a.velocity || 0))
      .slice(0, 100);

    // --- START: Generate Category Rankings ---
    const categoryRankings = {};
    // Use top 20 keywords for category rankings
    const topKeywordsForRanking = keywords.slice(0, 20); 
    for (const keyword of topKeywordsForRanking) {
        const categoryModels = activeModels
            .filter(m => m.tags && m.tags.includes(keyword.slug))
            .sort((a, b) => (b.popularityScore || 0) - (a.popularityScore || 0))
            .slice(0, 10); // Top 10 for each category
        
        if (categoryModels.length > 0) {
            categoryRankings[keyword.slug] = categoryModels;
        }
    }

    const allRankings = {
      hot: hotRanking,
      trending: trendingRanking,
      newest: newestRanking,
      rising: risingStarRanking,
      categories: categoryRankings,
      generatedAt: new Date().toISOString(),
    };

    writeDataToFile(CONFIG.RANKINGS_PATH, allRankings);
    console.log(`✅ Rankings data saved.`);
}

async function main() {
    console.log('--- Starting Free AI Tools Data Fetching Script ---');
    initializeDirectories();

    // --- NEW: Load existing models for stability check ---
    let existingModels = [];
    if (fs.existsSync(CONFIG.OUTPUT_FILE_PATH)) {
        try {
            existingModels = JSON.parse(fs.readFileSync(CONFIG.OUTPUT_FILE_PATH, 'utf-8'));
            console.log(`- Found ${existingModels.length} existing models. This will be used as a baseline for stability.`);
        } catch (e) {
            console.warn(`- Could not parse existing models.json. Will proceed without a stability baseline.`);
        }
    }
    // --- END NEW ---

    // 1. Fetch SOTA repo URLs from Papers with Code first
    const pwcRepoUrls = await fetchPwCData();

    // 2. Fetch data from all other sources, passing PwC URLs to the GitHub fetcher
    const sourcesData = await Promise.all([
        fetchHuggingFaceData(),
        fetchGitHubData(pwcRepoUrls),
    ]);

    const allRawModels = sourcesData.flat();

    // 3. Filter out NSFW content
    const sfwModels = allRawModels.filter(model => !isNsfw(model));
    console.log(`- Filtered down to ${sfwModels.length} SFW models.`);

    // 4. Create a map of new models for quick lookup
    const newModelsMap = new Map();
    for (const model of sfwModels) {
        const key = getModelKey(model.name);
        if (newModelsMap.has(key)) {
            // Merge logic
            const existing = newModelsMap.get(key);
            existing.likes += model.likes;
            existing.downloads += model.downloads;
            // If the model was previously archived, "resurrect" it by removing the flag
            if (existing.is_archived) {
                delete existing.is_archived;
                console.log(`- Resurrecting model: ${existing.name}`);
            }
            existing.tags = [...new Set([...existing.tags, ...model.tags])]; // Merge and deduplicate tags
            existing.sources.push(...model.sources);
        } else {
            newModelsMap.set(key, model);
        }
    }

    // 5. Implement "Soft Delete" / Archiving Logic
    const finalModelsMap = new Map(newModelsMap); // Start with all new models

    // Iterate through existing models to find ones that are no longer present
    if (existingModels.length > 0) {
        for (const oldModel of existingModels) {
            const key = getModelKey(oldModel.name);
            // If an old model is not in the new list, mark it as archived and add it back
            if (!newModelsMap.has(key)) {
                console.log(`- Archiving model: ${oldModel.name}`);
                oldModel.is_archived = true;
                // To prevent archived models from dominating, we can optionally reduce their scores
                oldModel.likes = 0; 
                oldModel.downloads = 0;
                finalModelsMap.set(key, oldModel);
            }
        }
    }


    // 6. Convert map back to array and sort
    let finalModels = Array.from(finalModelsMap.values());
    finalModels.sort((a, b) => b.likes - a.likes);

    // 6. Calculate velocity and identify rising stars
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    finalModels.forEach(model => {
        model.velocity = calculateVelocity(model);
        const createdAt = new Date(model.lastModified);
        // A project is a "rising star" if it's new and has gained significant traction.
        const isNewAndPopular = createdAt > thirtyDaysAgo && model.likes > 50;
        // Or if it shows high velocity regardless of age.
        const hasHighVelocity = model.velocity > 100; // Threshold for high daily likes

        model.is_rising_star = isNewAndPopular || hasHighVelocity;

        // --- NEW: Calculate Ranking Scores ---
        const logLikes = Math.log10(model.likes + 1); // +1 to avoid log(0)
        const logDownloads = Math.log10(model.downloads + 1);

        // Comprehensive "Heat Score"
        model.heatScore = (logLikes * 0.4) + (logDownloads * 0.3) + (model.velocity * 0.3);

        // Simpler "Popularity Score"
        model.popularityScore = (model.likes * 0.6) + (model.downloads * 0.4);
        // --- END NEW ---
    });

    console.log(`- Merged models down to ${finalModels.length} unique entries.`);

    // --- NEW: Stability and Sanity Check ---
    // Set a threshold. If the new model count is drastically lower than the old one (e.g., less than 80%),
    // it indicates a fetching error. In that case, we abort the update to maintain site stability.

    const minimumModelCount = Math.floor(existingModels.length * CONFIG.MINIMUM_MODEL_THRESHOLD_PERCENTAGE);

    // Check against the count of *newly fetched* models, not the final count which includes archives.
    if (newModelsMap.size < minimumModelCount && existingModels.length > 100) { 
        console.warn(`⚠️ STABILITY CHECK FAILED: New model count (${newModelsMap.size}) is less than 80% of the existing count (${existingModels.length}).`);
        console.warn('   This may indicate a data source failure. Switching to partial update mode.');

        // --- PARTIAL UPDATE LOGIC ---
        let updatedCount = 0;
        const existingModelsMap = new Map(existingModels.map(m => [getModelKey(m.name), m]));

        for (const [key, newModel] of newModelsMap.entries()) {
            if (existingModelsMap.has(key)) {
                const oldModel = existingModelsMap.get(key);
                // Merge new info into the old model object
                oldModel.likes = (oldModel.likes || 0) + newModel.likes;
                oldModel.downloads = (oldModel.downloads || 0) + newModel.downloads;
                oldModel.lastModified = newModel.lastModified;
                oldModel.lastModifiedTimestamp = newModel.lastModifiedTimestamp;
                // You can add more fields to update here, e.g., readme
                updatedCount++;
            }
        }
        console.log(`- Partially updated ${updatedCount} existing models.`);
        // Overwrite finalModels with the partially updated list
        finalModels = Array.from(existingModelsMap.values());
    } else {
        console.log('✅ Stability check passed. Proceeding with full update.');
    }
    // --- END NEW ---

    if (finalModels.length > 0) { // This check is now a secondary safeguard
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const archiveFilePath = path.join(CONFIG.ARCHIVE_DIR, `${today}.json`);

        const combinedData = finalModels; // Use the final merged and sorted data
        
        // Write to dated archive file and the main models.json
        writeDataToFile(archiveFilePath, combinedData);
        writeDataToFile(CONFIG.OUTPUT_FILE_PATH, combinedData);
        await writeToKV('models', JSON.stringify(combinedData));

        // Discover keywords based on the new category system
        const validatedKeywords = discoverAndSaveKeywords(combinedData);

    // --- NEW: Assign category tags to all models ---
    const categories = JSON.parse(fs.readFileSync(CONFIG.CATEGORIES_PATH, 'utf-8'));
    let taggedModels = assignTagsToModel(combinedData, categories);
    // --- END NEW ---

        // Generate and save all rankings
        generateAndSaveRankings(combinedData, validatedKeywords);

        // Generate AI report
        const newReport = await generateBiWeeklyReport(combinedData, validatedKeywords);
        if (newReport) await updateReportsFile(newReport);

        // Create search index from the final combined data
    createSearchIndex(taggedModels); // Use taggedModels to ensure search index has tags
    } else {
        console.log('🔥 No data was fetched, skipping file write and KV update.');
        // Still run updateReportsFile with null to ensure the file is present for the build.
        await updateReportsFile(null);
    }
    console.log('--- ✅ Data fetching script finished successfully! ---');
}

main();