const axios = require('axios');
const fs = require('fs');
const path = require('path');

// --- Configuration ---
const CIVITAI_DATA_PATH = path.join(__dirname, '../src/data/civitai.json');
const HUGGINGFACE_API_URL = 'https://huggingface.co/api/models?sort=likes&direction=-1&limit=100';
const OUTPUT_FILE_PATH = path.join(__dirname, '../public/models.json');
const ARCHIVE_DIR = path.join(__dirname, '../public/archives');
const NSFW_KEYWORDS = [
    'nsfw', 
    'porn', 
    'hentai', 
    'sexy', 
    'explicit', 
    'erotic', 
    'nude', 
    'naked',
    'adult'
];

/**
 * Normalizes a model name to create a consistent key for deduplication.
 * @param {string} name The name of the model.
 * @returns {string} A normalized string.
 */
function getModelKey(name) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function fetchHuggingFaceData() {
    console.log('📦 Fetching data from HuggingFace API...');
    try {
        const { data } = await axios.get(HUGGINGFACE_API_URL);
        const transformedData = await Promise.all(data.map(async (model) => {
            let readmeContent = null;
            try {
                // Attempt to fetch the README.md file for each model
                const readmeUrl = `https://huggingface.co/${model.modelId}/raw/main/README.md`;
                const readmeResponse = await axios.get(readmeUrl);
                readmeContent = readmeResponse.data;
            } catch (e) {
                // It's okay if a README doesn't exist, we'll just skip it.
            }

            return {
                id: model.modelId,
                name: model.modelId.split('/')[1] || model.modelId,
                author: model.author,
                description: model.cardData?.description || `A model for ${model.pipeline_tag || 'various tasks'}.`,
                task: model.pipeline_tag || 'N/A',
                tags: model.tags || [],
                likes: model.likes,
                downloads: model.downloads,
                lastModified: model.lastModified,
                readme: readmeContent,
                sources: [{ platform: 'Hugging Face', url: `https://huggingface.co/${model.modelId}` }],
            };
        }));
        console.log(`✅ Successfully fetched and transformed ${transformedData.length} models.`);
        return transformedData;
    } catch (error) {
        console.error('❌ Failed to fetch data from HuggingFace:', error.message);
        return []; // Return empty on error to avoid breaking the build
    }
}

async function fetchGitHubData() {
    console.log('📦 Fetching data from GitHub API...');
    const GITHUB_API_URL = 'https://api.github.com/search/repositories?q=topic:ai-tool&sort=stars&order=desc&per_page=50';
    try {
        const { data } = await axios.get(GITHUB_API_URL, {
            headers: { 'Accept': 'application/vnd.github.v3+json' }
        });
        const transformedData = data.items.map(repo => ({
            id: `github-${repo.full_name.replace('/', '-')}`,
            name: repo.name,
            author: repo.owner.login,
            description: repo.description || 'An AI tool from GitHub.',
            task: 'tool', // Assign a generic task for GitHub repos
            tags: repo.topics || [],
            likes: repo.stargazers_count,
            downloads: repo.watchers_count, // Using watchers as a proxy for downloads
            lastModified: repo.updated_at,
            sources: [{ platform: 'GitHub', url: repo.html_url }],
        }));
        console.log(`✅ Successfully fetched and transformed ${transformedData.length} models from GitHub.`);
        return transformedData;
    } catch (error) {
        console.error('❌ Failed to fetch data from GitHub:', error.message);
        if (error.response) {
            console.error(`    - Status: ${error.response.status}`);
            console.error(`    - Data: ${JSON.stringify(error.response.data)}`);
        }
        process.exit(1);
    }
}

function readCivitaiData() {
    console.log('📦 Reading data from Civitai JSON file...');
    try {
        if (!fs.existsSync(CIVITAI_DATA_PATH)) {
            console.warn(`- Civitai data file not found at ${CIVITAI_DATA_PATH}. Skipping.`);
            return [];
        }
        const civitaiData = JSON.parse(fs.readFileSync(CIVITAI_DATA_PATH, 'utf-8'));
        const transformedData = civitaiData.map(model => ({
            id: `civitai-${model.name.toLowerCase().replace(/\s+/g, '-')}`,
            name: model.name,
            author: model.creator?.username || 'Civitai Community',
            description: model.description || 'An image generation model from Civitai.',
            task: 'image-generation', // Assume all are image generation for now
            tags: model.tags || [],
            likes: model.stats?.favoriteCount || 0,
            downloads: model.stats?.downloadCount || 0,
            lastModified: model.lastUpdate || new Date().toISOString(),
            sources: [{ platform: 'Civitai', url: `https://civitai.com/models/${model.id}` }],
        }));
        console.log(`✅ Successfully read and transformed ${transformedData.length} models from Civitai.`);
        return transformedData;
    } catch (error) {
        console.error('❌ Failed to read or parse Civitai data:', error.message);
        return []; // Return empty array on error to not break the build
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
        const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, KV_NAMESPACE_ID } = process.env;

        if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN || !KV_NAMESPACE_ID) {
            console.error('❌ Missing Cloudflare credentials. Set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, and KV_NAMESPACE_ID.');
            process.exit(1);
        }

        const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${key}`;

        try {
            await axios.put(url, value, {
                headers: {
                    'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
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

function isNsfw(model) {
    const name = model.name.toLowerCase();
    const description = (model.description || '').toLowerCase();
    const tags = (model.tags || []).map(t => t.toLowerCase());

    for (const keyword of NSFW_KEYWORDS) {
        if (name.includes(keyword) || description.includes(keyword) || tags.includes(keyword)) {
            return true;
        }
    }
    return false;
}

async function main() {
    console.log('--- Starting AI-Nexus Data Fetching Script ---');
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const archiveFilePath = path.join(ARCHIVE_DIR, `${today}.json`);

    // 1. Fetch data from all sources
    const sourcesData = await Promise.all([
        fetchHuggingFaceData(),
        readCivitaiData(),
        fetchGitHubData(),
    ]);

    const allRawModels = sourcesData.flat();

    // 2. Filter out NSFW content
    const sfwModels = allRawModels.filter(model => !isNsfw(model));
    console.log(`- Filtered down to ${sfwModels.length} SFW models.`);

    // 3. Deduplicate and merge models
    const mergedModels = new Map();
    for (const model of sfwModels) {
        const key = getModelKey(model.name);
        if (mergedModels.has(key)) {
            // Merge logic
            const existing = mergedModels.get(key);
            existing.likes += model.likes;
            existing.downloads += model.downloads;
            existing.tags = [...new Set([...existing.tags, ...model.tags])]; // Merge and deduplicate tags
            existing.sources.push(...model.sources);
            // Prioritize description from Hugging Face or GitHub over others
            if (!existing.description.includes('from GitHub') && (model.description.includes('from GitHub') || model.sources.some(s => s.platform === 'Hugging Face'))) {
                existing.description = model.description;
            }
        } else {
            mergedModels.set(key, model);
        }
    }

    // 4. Convert map back to array and sort
    const finalModels = Array.from(mergedModels.values());
    finalModels.sort((a, b) => b.likes - a.likes);

    console.log(`- Merged models down to ${finalModels.length} unique entries.`);

    if (finalModels.length > 0) {
        const combinedData = finalModels; // Use the final merged and sorted data
        
        // 1. Write to dated archive file
        writeDataToFile(archiveFilePath, combinedData);

        // 2. Write to the main models.json for the build process
        writeDataToFile(OUTPUT_FILE_PATH, combinedData);
        await writeToKV('models', JSON.stringify(combinedData));
    } else {
        console.log('🔥 No data was fetched, skipping file write and KV update.');
    }
    console.log('--- ✅ Data fetching script finished successfully! ---');
}

main();
