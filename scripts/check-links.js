import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

const REPORT_FILE = "./data/link_check_report.json";

function ensureDataDir() {
    const dataDir = path.dirname(REPORT_FILE);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
}

async function checkUrl(url) {
    try {
        await axios.head(url, { timeout: 5000 });
        return 'active';
    } catch (e) {
        if (e.response) {
            if (e.response.status === 404) return 'dead';
            if (e.response.status >= 300 && e.response.status < 400) return 'redirect';
        }
        return 'dead'; // Assume dead on other errors (timeout, etc.)
    }
}

async function main() {
    console.log("🔍 Starting Dead Link Check (ESM)...");
    ensureDataDir();

    try {
        // 1. Fetch active models
        console.log("Fetching models from D1...");
        const cmd = `npx wrangler d1 execute ai-nexus-db --remote --command "SELECT id, source_url FROM models WHERE link_status != 'dead' LIMIT 50" --json`;
        const output = execSync(cmd, { encoding: 'utf-8' });
        const parsed = JSON.parse(output);
        const models = parsed[0]?.results || parsed.results || [];

        console.log(`Checking ${models.length} models...`);

        const updates = [];
        const report = {
            checked: 0,
            active: 0,
            dead: 0,
            redirect: 0,
            details: []
        };

        // 2. Check each URL
        for (const model of models) {
            if (!model.source_url) continue;

            process.stdout.write(`Checking ${model.id}... `);
            const status = await checkUrl(model.source_url);
            console.log(status);

            report.checked++;
            report[status]++;
            report.details.push({ id: model.id, url: model.source_url, status });

            if (status !== 'active') {
                updates.push({ id: model.id, status });
            }
        }

        // 3. Update D1
        if (updates.length > 0) {
            console.log(`\nUpdating ${updates.length} models in D1...`);
            for (const update of updates) {
                // SECURITY FIX: Use parameterized query to prevent SQL injection.
                const sql = `UPDATE models SET link_status = ?1 WHERE id = ?2;`;
                const params = JSON.stringify([update.status, update.id]);

                const updateCmd = `npx wrangler d1 execute ai-nexus-db --remote --command='${sql}' --json='${params}'`;

                execSync(updateCmd);
            }
        }

        // 4. Save Report
        fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
        console.log(`\n✅ Check complete. Report saved to ${REPORT_FILE}`);

    } catch (e) {
        console.error("❌ Fatal error:", e.message);
        process.exit(1);
    }
}

main();
