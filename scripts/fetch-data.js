const axios = require('axios');

// --- Configuration ---
// HuggingFace API: Fetch top 100 models sorted by likes, ensuring stability and quality. 
const HUGGINGFACE_API_URL = 'https://huggingface.co/api/models?sort=likes&direction=-1&limit=100';

// Cloudflare KV Configuration is read from environment variables, as per the project plan. 
const { CF_ACCOUNT_ID, CF_API_TOKEN, KV_NAMESPACE_ID } = process.env; 
const KV_KEY_NAME = 'huggingface_models'; // The key where the model data will be stored in the KV namespace.

/**
 * Fetches and transforms model data from the HuggingFace API.
 * This function is designed to be reliable for automated execution in a CI/CD environment.
 */ 
async function fetchHuggingFaceData() {
    console.log('📦 Fetching data from HuggingFace API...');
    try {
        const { data } = await axios.get(HUGGINGFACE_API_URL);

        // Transform the raw API data into a clean, structured format for our application.
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
        // Exit with a non-zero code to signal failure to the GitHub Action runner.
        process.exit(1);
    }
}

/**
 * Writes the provided data to the Cloudflare KV namespace.
 * @param {string} key The key to store the data under.
 * @param {any} data The JSON-serializable data to store.
 */ 
async function writeToCloudflareKV(key, data) {
    console.log(`- Writing data to Cloudflare KV under key: ${key}`);
    const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${key}`;

    try {
        await axios.put(url, JSON.stringify(data), {
            headers: {
                'Authorization': `Bearer ${CF_API_TOKEN}`,
                'Content-Type': 'application/json',
            },
        });
        console.log('✅ Successfully wrote data to Cloudflare KV.');
    } catch (error) {
        console.error('❌ Failed to write to Cloudflare KV:', error.message);
        if (error.response) {
            console.error(`    - Status: ${error.response.status}`);
            console.error(`    - Data: ${JSON.stringify(error.response.data)}`);
        }
        // Exit with a non-zero code to signal failure.
        process.exit(1);
    }
}

/**
 * Main execution function to orchestrate the data fetching and storage process.
 */ 
async function main() {
    console.log('--- Starting AI-Nexus Data Fetching Script ---');

    // 1. Validate that all required environment variables are present.
    if (!CF_ACCOUNT_ID || !CF_API_TOKEN || !KV_NAMESPACE_ID) {
        console.error('❌ Missing required Cloudflare environment variables (CF_ACCOUNT_ID, CF_API_TOKEN, KV_NAMESPACE_ID).');
        process.exit(1);
    }

    // 2. Fetch the data from the primary source.
    const modelsData = await fetchHuggingFaceData();

    // 3. Write the fetched data to Cloudflare KV for use by the application.
    if (modelsData && modelsData.length > 0) {
        await writeToCloudflareKV(KV_KEY_NAME, modelsData);
    } else {
        console.log('⭐ No data was fetched, skipping write to Cloudflare KV.');
    }

    console.log('--- ✅ Data fetching script finished successfully! ---');
}

// Execute the main function. 
main();