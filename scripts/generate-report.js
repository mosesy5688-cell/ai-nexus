import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG = {
    RANKINGS_PATH: path.join(__dirname, '../public/data/rankings.json'),
    KEYWORDS_PATH: path.join(__dirname, '../public/data/keywords.json'),
    REPORTS_OUTPUT_PATH: path.join(__dirname, '../src/data/reports.json'),
    REPORT_ARCHIVE_DIR: path.join(__dirname, '../src/data/report-archives'),
};

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
// Use a model that supports the prompt size and complexity
const geminiModel = genAI ? genAI.getGenerativeModel({ model: 'gemini-1.5-flash' }) : null;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

    // Prepare data section
    const risingStars = latestModels.filter(m => m.is_rising_star).slice(0, 10);
    const bigMovers = latestModels.sort((a, b) => (b.velocity || 0) - (a.velocity || 0)).slice(0, 10);

    const dataSection = `
**[INPUT DATA - PROVIDED BY FREE AI TOOLS PLATFORM]**
* **BIG_MOVERS (Top 10 by Velocity Score):** ${JSON.stringify(bigMovers.map(m => ({ name: m.name, velocity: m.velocity, description: m.description })), null, 2)}
* **NEW_STARS (Top 10 Rising Stars):** ${JSON.stringify(risingStars.map(m => ({ name: m.name, description: m.description })), null, 2)}
* **Top Keywords:** ${JSON.stringify(keywords.slice(0, 10), null, 2)}
`;
    return (reportPrompt + dataSection);
}

function linkEntitiesInReport(reportContent, allModels, allKeywords) {
    console.log('- Linking entities within the report...');
    let linkedContent = reportContent;

    // Sort models by name length, descending
    const sortedModels = [...allModels].sort((a, b) => b.name.length - a.name.length);

    // Link models
    sortedModels.forEach(model => {
        const slug = model.slug || model.id.replace(/\//g, '--');
        const modelLink = `[${model.name}](/model/${slug})`;
        const regex = new RegExp(`\\b${escapeRegExp(model.name)}\\b(?!(\\]\\(\\/model\\/)|(\\s*\\-))`, 'gi');
        linkedContent = linkedContent.replace(regex, modelLink);
    });

    // Link keywords
    allKeywords.forEach(keyword => {
        const keywordLink = `[${keyword.title}](/explore?tag=${keyword.slug})`;
        const regex = new RegExp(`\\b${escapeRegExp(keyword.title)}\\b(?!(\\]\\(\\/explore\\?tag=))`, 'gi');
        linkedContent = linkedContent.replace(regex, keywordLink);
    });

    return linkedContent;
}

function writeDataToFile(filePath, data) {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('❌ Failed to write data to file:', error.message);
    }
}

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
            return null;
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

    // Use top 50 models for context
    const latestModels = models.slice(0, 50);

    // --- Dynamic Date Calculation for Prompt ---
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

            if (responseText.includes('# Free AI Tools Bi-Weekly Industry Analysis Report') && responseText.includes('## 1. Executive Summary')) {
                console.log(`✅ AI weekly report generated successfully for ${reportId} on attempt ${attempt}.`);

                const linkedContent = linkEntitiesInReport(responseText, models, keywords);

                const titleMatch = linkedContent.match(/^#\s*(.*)/m);
                const summaryMatch = linkedContent.match(/##\s*1\.\s*Executive Summary\s*\n+([\s\S]*?)\n##/);

                const report = {
                    reportId: reportId,
                    title: titleMatch ? titleMatch[1].trim().replace('[Date Range]', dateRange) : `Free AI Tools Bi-Weekly Report - ${dateRange}`,
                    date: reportId,
                    summary: summaryMatch ? summaryMatch[1].trim().substring(0, 300) + '...' : "A bi-weekly analysis of the open-source AI landscape.",
                    content: linkedContent,
                    featuredModelIds: [],
                    tags: ["bi-weekly-report", "ai-trends", "industry-analysis"]
                };
                return report;
            } else {
                throw new Error("Generated report is missing required structure.");
            }
        } catch (error) {
            console.error(`❌ Attempt ${attempt} failed to generate AI weekly report:`, error.message);
            if (attempt < MAX_RETRIES) {
                const delay = Math.pow(2, attempt) * 1000;
                console.log(`- Retrying in ${delay / 1000} seconds...`);
                await sleep(delay);
            }
        }
    }

    console.error('❌ AI report generation failed after all retries.');
    return null;
}

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

        const reportArchivePath = path.join(CONFIG.REPORT_ARCHIVE_DIR, `${newReport.reportId}.json`);
        console.log(`- Saving report to long-term archive: ${reportArchivePath}`);
        writeDataToFile(reportArchivePath, newReport);

        reports.unshift(newReport);
        const slicedReports = reports.slice(0, 52);
        console.log(`- Updating main reports file with ${slicedReports.length} most recent reports.`);
        writeDataToFile(CONFIG.REPORTS_OUTPUT_PATH, slicedReports);
    } else {
        console.log('✅ No new report generated. Skipping reports file update.');
    }
}

async function main() {
    console.log('🚀 Starting Loop 5: AI Reporting...');

    if (!fs.existsSync(CONFIG.RANKINGS_PATH)) {
        console.error('❌ Rankings file not found. Run Loop 3 first.');
        process.exit(1);
    }

    if (!fs.existsSync(CONFIG.KEYWORDS_PATH)) {
        console.error('❌ Keywords file not found. Run Loop 3 first.');
        process.exit(1);
    }

    const rankings = JSON.parse(fs.readFileSync(CONFIG.RANKINGS_PATH, 'utf-8'));
    const keywords = JSON.parse(fs.readFileSync(CONFIG.KEYWORDS_PATH, 'utf-8'));

    // Combine models from rankings for context
    // We want a mix of hot, trending, and new
    const allModelsMap = new Map();
    [...rankings.hot, ...rankings.trending, ...rankings.new, ...rankings.rising].forEach(m => {
        allModelsMap.set(m.id, m);
    });
    const allModels = Array.from(allModelsMap.values());

    console.log(`📚 Loaded ${allModels.length} unique models from rankings.`);

    const report = await generateBiWeeklyReport(allModels, keywords);
    await updateReportsFile(report);

    console.log('✅ Loop 5 completed successfully.');
}

main();
