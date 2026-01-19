import fs from 'fs';
import path from 'path';
import { buildReportPrompt } from './prompts/bi-weekly-report.js';
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
    const WEEKLY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // Changed from 14 to 7 days
    console.log("- Checking if a weekly report is due...");

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
        if (timeSinceLastReport < WEEKLY_INTERVAL_MS) {
            const daysRemaining = Math.ceil((WEEKLY_INTERVAL_MS - timeSinceLastReport) / (1000 * 60 * 60 * 24));
            console.log(`✅ Weekly report skipped. Next report due in approximately ${daysRemaining} days.`);
            return null;
        }
    }

    console.log("📦 7 days elapsed or no previous report found. Generating new weekly report...");

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

        // V16: R2 Integration
        if (process.argv.includes('--upload')) {
            console.log('📤 Uploading reports to R2...');
            try {
                const { execSync } = await import('child_process');
                // Upload main index
                execSync(`npx wrangler r2 object put "ai-nexus-assets/cache/reports.json" --file="${CONFIG.REPORTS_OUTPUT_PATH}" --remote`, { stdio: 'inherit' });
                // Upload archive
                execSync(`npx wrangler r2 object put "ai-nexus-assets/cache/reports/archives/${newReport.reportId}.json" --file="${reportArchivePath}" --remote`, { stdio: 'inherit' });
                console.log('✅ R2 Upload Success');
            } catch (e) {
                console.error('❌ R2 Upload Failed:', e.message);
            }
        }
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
