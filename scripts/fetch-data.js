const axios = require('axios');
const fs = require('fs');
const path = require('path');

// --- Configuration ---
const HUGGINGFACE_API_URL = 'https://huggingface.co/api/models?sort=likes&direction=-1&limit=100';
const OUTPUT_FILE_PATH = path.join(__dirname, '../public/models.json');

async function fetchHuggingFaceData() {
    console.log('📦 Fetching data from HuggingFace API...');
    try {
        const { data } = await axios.get(HUGGINGFACE_API_URL);
        const transformedData = data.map(model => ({
            id: model.modelId,
            name: model.modelId.split('/')[1] || model.modelId,
            author: model.author,
            source: `https://huggingface.co/${model.modelId}`,
            task: model.pipeline_tag || 'N/A',
            tags: model.tags || [],
            likes: model.likes,
            downloads: model.downloads,
            lastModified: model.lastModified,
        }));
        console.log(`✅ Successfully fetched and transformed ${transformedData.length} models.`);
        return transformedData;
    } catch (error) {
        console.error('❌ Failed to fetch data from HuggingFace:', error.message);
        if (error.response) {
            console.error(`    - Status: ${error.response.status}`);
            console.error(`    - Data: ${JSON.stringify(error.response.data)}`);
        }
        process.exit(1);
    }
}

function writeDataToFile(filePath, data) {
    console.log(`- Writing data to static file: ${filePath}`);
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        console.log('✅ Successfully wrote data to file.');
    } catch (error) {
        console.error('❌ Failed to write data to file:', error.message);
        process.exit(1);
    }
}

async function writeToKV(key, value) {
    if (process.env.CI) {
        console.log('CI environment detected, writing to Cloudflare KV...');
        const { CF_ACCOUNT_ID, CF_API_TOKEN, KV_NAMESPACE_ID } = process.env;

        if (!CF_ACCOUNT_ID || !CF_API_TOKEN || !KV_NAMESPACE_ID) {
            console.error('❌ Missing Cloudflare credentials. Set CF_ACCOUNT_ID, CF_API_TOKEN, and KV_NAMESPACE_ID.');
            process.exit(1);
        }

        const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${key}`;

        try {
            await axios.put(url, value, {
                headers: {
                    'Authorization': `Bearer ${CF_API_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            });
            console.log(`✅ Successfully wrote data for key: "${key}" to Cloudflare KV.`);
        } catch (error) {
            console.error('❌ Failed to write data to Cloudflare KV:', error.message);
            if (error.response) {
                console.error('    - Error details:', error.response.data);
            }
            process.exit(1);
        }
    } else {
        console.log('Not in CI environment, skipping KV write.');
    }
}

async function main() {
    console.log('--- Starting AI-Nexus Data Fetching Script ---');
    const modelsData = await fetchHuggingFaceData();
    if (modelsData && modelsData.length > 0) {
        writeDataToFile(OUTPUT_FILE_PATH, modelsData);
        await writeToKV('models', JSON.stringify(modelsData));
    } else {
        console.log('🔥 No data was fetched, skipping file write and KV update.');
    }
    console.log('--- ✅ Data fetching script finished successfully! ---');
}

main();