import { execSync } from 'child_process';
import axios from 'axios';

// Configuration
const BATCH_SIZE = 5; // Process 5 models per run to avoid timeout/rate limits
const MODEL_ID = "@cf/meta/llama-3-8b-instruct"; // Cloudflare Workers AI Model

async function runEnrichment() {
    console.log("✨ Starting AI Content Enrichment (Loop 2)...");

    try {
        // 1. Fetch models needing enrichment
        // We look for models where seo_summary is NULL or empty
        console.log("Fetching candidates from D1...");
        const query = `SELECT id, name, author, description, tags FROM models WHERE seo_summary IS NULL OR seo_summary = '' LIMIT ${BATCH_SIZE}`;
        const cmd = `npx wrangler d1 execute ai-nexus-db --remote --command "${query}" --json`;

        const output = execSync(cmd, { encoding: 'utf-8' });
        const parsed = JSON.parse(output);
        const candidates = parsed[0]?.results || parsed.results || [];

        if (candidates.length === 0) {
            console.log("✅ No models need enrichment.");
            return;
        }

        console.log(`Found ${candidates.length} models to enrich.`);

        // 2. Process each candidate
        for (const model of candidates) {
            console.log(`\n🤖 Enriching: ${model.name} (${model.id})...`);

            const summary = await generateSummary(model);

            if (summary) {
                console.log(`   -> Generated summary (${summary.length} chars)`);
                updateDatabase(model.id, summary);
            } else {
                console.warn(`   -> Failed to generate summary.`);
            }
        }

    } catch (e) {
        console.error("❌ Fatal error in enrichment loop:", e.message);
        process.exit(1);
    }
}

async function generateSummary(model) {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;

    if (!accountId || !apiToken) {
        throw new Error("Missing Cloudflare credentials (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN)");
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL_ID}`;

    const prompt = `
You are an expert AI technical writer. Your task is to write a concise, engaging, and SEO-friendly summary for an AI model.
Use the following metadata:
- Name: ${model.name}
- Author: ${model.author}
- Description: ${model.description}
- Tags: ${model.tags}

Requirements:
1. Length: 2-3 sentences (approx 50-80 words).
2. Tone: Professional, informative, and exciting.
3. Keywords: Naturally include the model name and key tags.
4. Output: Return ONLY the summary text. Do not include "Here is the summary" or quotes.
    `.trim();

    try {
        const response = await axios.post(url, {
            messages: [
                { role: "system", content: "You are a helpful assistant that generates SEO summaries for AI models." },
                { role: "user", content: prompt }
            ]
        }, {
            headers: {
                'Authorization': `Bearer ${apiToken}`,
                'Content-Type': 'application/json'
            }
        });

        return response.data.result.response.trim();

    } catch (e) {
        console.error("   -> AI API Error:", e.response?.data || e.message);
        return null;
    }
}

function updateDatabase(id, summary) {
    // Use parameterized query for safety
    const sql = `UPDATE models SET seo_summary = ?1 WHERE id = ?2;`;
    const params = JSON.stringify([summary, id]);

    const cmd = `npx wrangler d1 execute ai-nexus-db --remote --command='${sql}' --json='${params}'`;
    execSync(cmd);
    console.log("   -> Database updated.");
}

runEnrichment();
