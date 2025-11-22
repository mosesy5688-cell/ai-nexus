// scripts/check-links.js
// Implements Loop 4: Auto-Ops (Dead Link Checker)

// Note: This script is intended to be run in a Cloudflare Worker or environment with D1 access.
// Since GitHub Actions cannot directly access D1 without Wrangler, and Wrangler D1 access from Actions
// is usually for migrations/executions via file, we might need to use the HTTP API or a Worker.
// However, for the blueprint's sake, we will implement a Node.js script that *could* run if it had access,
// or we can use `wrangler d1 execute` to fetch and update.

const { execSync } = require('child_process');
const https = require('https');

async function checkLinks() {
    console.log("Starting Dead Link Check...");

    try {
        // 1. Fetch candidates from D1 using Wrangler
        // We use JSON output to parse it in Node
        const cmd = `npx wrangler d1 execute DB --remote --command "SELECT id, source_url FROM models WHERE link_status = 'alive' LIMIT 50" --json`;
        console.log("Fetching links from D1...");
        const output = execSync(cmd, { encoding: 'utf-8' });
        const result = JSON.parse(output);

        // Handle different wrangler output formats (sometimes array of results, sometimes object)
        const rows = result[0]?.results || result.results || [];

        if (rows.length === 0) {
            console.log("No links to check.");
            return;
        }

        console.log(`Checking ${rows.length} links...`);

        for (const row of rows) {
            const { id, source_url } = row;
            if (!source_url) continue;

            const isAlive = await checkUrl(source_url);

            if (!isAlive) {
                console.log(`[BROKEN] ${id}: ${source_url}`);
                // Update status to broken
                const updateCmd = `npx wrangler d1 execute DB --remote --command "UPDATE models SET link_status = 'broken', last_checked = CURRENT_TIMESTAMP WHERE id = '${id}'"`;
                execSync(updateCmd);
            } else {
                console.log(`[ALIVE] ${id}`);
                // Optional: Update last_checked even if alive
                // const updateCmd = `npx wrangler d1 execute DB --remote --command "UPDATE models SET last_checked = CURRENT_TIMESTAMP WHERE id = '${id}'"`;
                // execSync(updateCmd);
            }
        }

    } catch (error) {
        console.error("Error during link check:", error.message);
        // Don't fail the build, just log
    }
}

function checkUrl(url) {
    return new Promise((resolve) => {
        const req = https.request(url, { method: 'HEAD', timeout: 5000 }, (res) => {
            if (res.statusCode >= 200 && res.statusCode < 400) {
                resolve(true);
            } else {
                resolve(false);
            }
        });

        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });

        req.end();
    });
}

checkLinks();
