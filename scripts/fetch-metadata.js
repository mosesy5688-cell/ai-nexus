import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const HF_API_URL = "https://huggingface.co/api/models?sort=likes&direction=-1&limit=100&full=true";
const OUTPUT_FILE = path.join(__dirname, '../data/raw.json');
const PROXY_URL = process.env.CF_PROXY_URL; // Optional proxy

async function fetchModels() {
    console.log("Starting metadata fetch...");

    let url = HF_API_URL;
    if (PROXY_URL) {
        console.log(`Using proxy: ${PROXY_URL}`);
        // Simple proxy implementation logic if needed, or just use the proxy URL directly if it handles the target
        // For now, we assume PROXY_URL might be a worker that forwards requests
        // url = `${PROXY_URL}?target=${encodeURIComponent(HF_API_URL)}`;
    }

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();

        // Ensure data directory exists
        const dataDir = path.dirname(OUTPUT_FILE);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
        console.log(`Successfully fetched ${data.length} models and saved to ${OUTPUT_FILE}`);
    } catch (error) {
        console.error("Error fetching metadata:", error);
        process.exit(1);
    }
}

fetchModels();
