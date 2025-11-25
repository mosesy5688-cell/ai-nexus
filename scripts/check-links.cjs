// scripts/check-links.cjs (Fixed for latest Wrangler CLI)
const { execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const { URL } = require('url');

function checkLinks() {
    try {
        console.log("Starting Dead Link Check...");

        // Execute SQL query to get active links from D1 (WITHOUT --remote)
        const output = execSync(
            `wrangler d1 execute ai-nexus-db --command "SELECT id, source_url FROM models WHERE link_status = 'active' LIMIT 50" --json`,
            { encoding: 'utf-8' }
        );

        const results = JSON.parse(output);
        const links = results[0]?.results || results.results || [];

        console.log(`Fetched ${links.length} links from D1...`);

        if (links.length === 0) {
            console.log("No active links to check.");
            return;
        }

        // Create data directory if it doesn't exist
        if (!fs.existsSync('./data')) {
            fs.mkdirSync('./data', { recursive: true });
        }

        // Save results for reference
        fs.writeFileSync('./data/active_links.json', JSON.stringify(links, null, 2));
        console.log("Active links saved to ./data/active_links.json");

        // Check each link (simplified version)
        let deadCount = 0;
        for (const link of links) {
            const { id, source_url } = link;
            if (!source_url) continue;

            console.log(`Checking ${source_url}...`);
            const isAlive = checkUrl(source_url);

            if (!isAlive) {
                console.log(`  ❌ DEAD: ${source_url}`);
                deadCount++;
                // Update D1 to mark as dead (WITHOUT --remote)
                try {
                    execSync(
                        `wrangler d1 execute ai-nexus-db --command "UPDATE models SET link_status = 'dead' WHERE id = '${id}'"`,
                        { encoding: 'utf-8' }
                    );
                } catch (err) {
                    console.error(`  Failed to update ${id}:`, err.message);
                }
            } else {
                console.log(`  ✅ OK`);
            }
        }

        console.log(`\nDead Link Check finished. Found ${deadCount} dead links.`);
    } catch (err) {
        console.error("Error in checkLinks:", err.message);
        process.exit(1);
    }
}

function checkUrl(url) {
    try {
        const urlObj = new URL(url);
        const options = {
            method: 'HEAD',
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            timeout: 5000
        };

        return new Promise((resolve) => {
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
    } catch (err) {
        return false;
    }
}

checkLinks();
