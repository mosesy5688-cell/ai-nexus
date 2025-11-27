import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { collect as collectHuggingFace } from './collectors/huggingface.js';
import { collect as collectPyTorch } from './collectors/pytorch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_FILE = path.join(__dirname, '../data/raw.json');

async function main() {
    console.log("🚀 Starting Multi-Source Collection...");

    // Run collectors in parallel
    const results = await Promise.all([
        collectHuggingFace(),
        collectPyTorch()
    ]);

    // Flatten results
    const allModels = results.flat();

    console.log(`\n📊 Collection Summary:`);
    console.log(`- Total Models: ${allModels.length}`);

    // Ensure data directory exists
    const dataDir = path.dirname(OUTPUT_FILE);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allModels, null, 2));
    console.log(`✅ Data saved to ${OUTPUT_FILE}`);
}

main().catch(err => {
    console.error("❌ Fatal error in collector scheduler:", err);
    process.exit(1);
});
