// scripts/check-links.cjs (CommonJS - fixed user's ES Module syntax)
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const outputFile = "./data/active_links.json";

function ensureDataDir() {
    const dataDir = path.dirname(outputFile);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
}

function ensureLastUpdatedColumn() {
    try {
        // SQLite doesn't support IF NOT EXISTS for ALTER TABLE
        // We'll try to add it and catch the error if it already exists
        execSync(
            `wrangler d1 execute ai-nexus-db --command "ALTER TABLE models ADD COLUMN last_updated TEXT DEFAULT CURRENT_TIMESTAMP;"`,
            { encoding: "utf-8" }
        );
        console.log("✅ Added 'last_updated' column.");
    } catch (err) {
        // Column already exists (expected error)
        if (err.message.includes("duplicate column")) {
            console.log("ℹ️  'last_updated' column already exists.");
        } else {
            console.warn("⚠️  Warning: Could not add 'last_updated' column:", err.message);
        }
    }
}

function checkLinks() {
    console.log("Starting Dead Link Check...\n");

    ensureDataDir();
    ensureLastUpdatedColumn();

    try {
        console.log("Fetching active links from D1...");
        const result = execSync(
            `wrangler d1 execute ai-nexus-db --command "SELECT id, source_url, link_status FROM models WHERE link_status = 'active' LIMIT 50;" --json`,
            { encoding: "utf-8" }
        );

        const parsed = JSON.parse(result);
        const links = parsed[0]?.results || parsed.results || [];

        fs.writeFileSync(outputFile, JSON.stringify(links, null, 2));
        console.log(`\n✅ Fetched ${links.length} active links.`);
        console.log(`📁 Saved to: ${outputFile}`);

        return links;
    } catch (err) {
        console.error("❌ Error in checkLinks:", err.message);
        process.exit(1);
    }
}

// Run the check
const links = checkLinks();
console.log(`\n🎯 Dead Link Check completed successfully!`);
