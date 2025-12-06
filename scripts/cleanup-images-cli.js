
import { execSync } from 'child_process';

function runWrangler(command) {
    try {
        // 2025-12-07: Use --json to get structured output
        // Use npx to ensure we use the project's wrangler
        // Escape double quotes in command for shell
        const escapedCommand = command.replace(/"/g, '\\"');
        return execSync(`npx wrangler d1 execute DB --remote --json --command "${escapedCommand}"`, { encoding: 'utf-8' });
    } catch (e) {
        console.error('Wrangler command failed:', e.message);
        return null;
    }
}

async function main() {
    console.log('🔍 Scanning available models...');

    // 1. Fetch models with potential images (Markdown or HTML)
    // Check for ![ (markdown) or <img (HTML)
    const fetchSql = "SELECT id, analysis_content FROM models WHERE analysis_content LIKE '%![%' OR analysis_content LIKE '%<img%'";
    const output = runWrangler(fetchSql);

    if (!output) return;

    let data;
    try {
        const json = JSON.parse(output);
        // Wrangler D1 output structure: [{ results: [], success: true, ... }]
        data = json[0]?.results || [];
    } catch (e) {
        console.error('Failed to parse JSON:', output);
        return;
    }

    console.log(`Found ${data.length} candidates.`);

    // Regex for markdown images: ![alt](url)
    const mdImgRegex = /!\[.*?\]\(.*?\)/g;
    // Regex for HTML images: <imgSrc ...>
    const htmlImgRegex = /<img[^>]*>/g;

    for (const model of data) {
        if (!model.analysis_content) continue;

        let cleanContent = model.analysis_content;
        let modified = false;

        if (mdImgRegex.test(cleanContent)) {
            cleanContent = cleanContent.replace(mdImgRegex, '');
            modified = true;
        }

        if (htmlImgRegex.test(cleanContent)) {
            cleanContent = cleanContent.replace(htmlImgRegex, '');
            modified = true;
        }

        if (modified) {
            console.log(`🧹 Cleaning model: ${model.id}`);

            // Escape single quotes for SQL: ' -> ''
            const safeContent = cleanContent.replace(/'/g, "''").replace(/\n/g, '\\n');

            const updateSql = `UPDATE models SET analysis_content = '${safeContent}' WHERE id = '${model.id}'`;
            runWrangler(updateSql);
        }
    }

    console.log('✅ Cleanup complete.');
}

main();
