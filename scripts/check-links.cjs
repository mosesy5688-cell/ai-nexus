// scripts/check-links.cjs (CommonJS version)
// Implements Loop 4: Auto-Ops (Dead Link Checker)

const { execSync } = require('child_process');
const https = require('https');

async function checkLinks() {
    console.log("Starting Dead Link Check...");

    try {
        // 1. Fetch candidates from D1 using Wrangler
        const cmd = `wrangler d1 execute ai-nexus-db --remote --command "SELECT id, source_url FROM models WHERE link_status = 'active' LIMIT 50" --json`;
        console.log("Fetching links from D1...");
        const output = execSync(cmd, { encoding: 'utf-8' });
        const result = JSON.parse(output);

        // Handle different wrangler output formats
        const rows = result[0]?.results || result.results || [];

        if (rows.length === 0) {
            console.log("No links to check.");
            return;
        }

        console.log(`Found ${rows.length} links to check.`);

        // 2. Check each link
        const deadLinks = [];
        for (const row of rows) {
            const { id, source_url } = row;
            console.log(`Checking: ${source_url}`);

            try {
                const isAlive = await checkUrl(source_url);
                if (!isAlive) {
                    deadLinks.push(id);
                    console.log(`  ❌ DEAD: ${source_url}`);
                } else {
                    console.log(`  ✅ OK: ${source_url}`);
                }
            } catch (err) {
                console.error(`  ⚠️  ERROR checking ${source_url}:`, err.message);
            }
        }

        // 3. Update dead links in D1
        if (deadLinks.length > 0) {
            console.log(`\nUpdating ${deadLinks.length} dead links...`);
            for (const id of deadLinks) {
                const updateCmd = `wrangler d1 execute ai-nexus-db --remote --command "UPDATE models SET link_status = 'dead' WHERE id = '${id}'"`;
                execSync(updateCmd);
            }
            console.log("Dead links updated successfully.");
        } else {
            console.log("\n✅ All links are alive!");
        }

    } catch (error) {
        console.error("Error in checkLinks:", error.message);
        throw error;
    }
}

function checkUrl(url) {
    return new Promise((resolve) => {
        const urlObj = new URL(url);
        const options = {
            method: 'HEAD',
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            timeout: 5000
        };

        const req = https.request(options, (res) => {
            resolve(res.statusCode >= 200 && res.statusCode < 400);
        });

        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });

        req.end();
    });
}

// Run the check
checkLinks().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
