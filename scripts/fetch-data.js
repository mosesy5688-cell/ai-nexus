    const axios = require('axios');
    const fs = require('fs');
    const path = require('path');

    // --- Configuration ---
    // HuggingFace API: Fetch top 100 models sorted by likes, ensuring stability and quality. 
    const HUGGINGFACE_API_URL = 'https://huggingface.co/api/models?sort=likes&direction=-1&limit=100';

    // The local file path where the static data will be stored. 
    const OUTPUT_FILE_PATH = path.join(__dirname, '../src/data/models.json');

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
     * Writes the provided data to a local JSON file.
     * @param {string} filePath The path to the output file. 
     * @param {any} data The JSON-serializable data to store.
     */ 
    function writeDataToFile(filePath, data) {
        console.log(`- Writing data to static file: ${filePath}`);
        try {
            // Ensure the directory exists before writing the file. 
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            // Write data as a formatted JSON string to ensure readability. 
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
            console.log('✅ Successfully wrote data to file.');
        } catch (error) {
            console.error('❌ Failed to write data to file:', error.message);
            
            // Exit with a non-zero code to signal failure. 
            process.exit(1);
        }
    }

    /**
     * Main execution function to orchestrate the data fetching and storage process.
     */ 
    async function main() {
        console.log('--- Starting AI-Nexus Data Fetching Script (Static JSON Strategy) ---');
        
        // 1. Fetch the data from the primary source. 
        const modelsData = await fetchHuggingFaceData();
        
        // 2. Write the fetched data to a local JSON file for the static site. 
        if (modelsData && modelsData.length > 0) {
            writeDataToFile(OUTPUT_FILE_PATH, modelsData);
        } else {
            console.log('🔥 No data was fetched, skipping file write.');
        }
        
        console.log('--- ✅ Data fetching script finished successfully! ---');
    }

    // Execute the main function. 
    main();
    