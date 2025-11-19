import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const KEYWORDS_PATH = path.join(__dirname, '../src/data/keywords.json');
const MODELS_PATH = path.join(__dirname, '../src/data/models.json');
const KEYWORD_DATA_OUTPUT_PATH = path.join(__dirname, '../src/data/keyword_pages.json');

async function main() {
  console.log('🚀 Starting keyword page data generation...');

  try {
    // 1. Read Keywords and Models
    const keywordsJson = await fs.readFile(KEYWORDS_PATH, 'utf-8');
    const allKeywords = JSON.parse(keywordsJson);

    const modelsJson = await fs.readFile(MODELS_PATH, 'utf-8');
    const allModels = JSON.parse(modelsJson);

    const keywordPagesData = {};

    // 2. Process Each Keyword
    for (const keyword of allKeywords) {
      const keywordSlug = keyword.slug;
      console.log(`🔍 Processing keyword: "${keyword.title}"`);

      // Find relevant models
      const relevantModels = allModels.filter(model => 
        (model.tags || []).includes(keywordSlug)
      );

      if (relevantModels.length === 0) {
        console.log(`🟡 No models found for "${keyword.title}". Skipping.`);
        continue;
      }

      console.log(`✅ Found ${relevantModels.length} models.`);

      // Generate SEO metadata
      const pageTitle = `Top AI Models for ${keyword.title}`;
      const pageDescription = `Discover ${relevantModels.length} leading AI models and tools for ${keyword.title}. Explore detailed information, use cases, and more on free2aitools.com.`;

      keywordPagesData[keywordSlug] = {
        title: pageTitle,
        description: pageDescription,
        keyword: keyword,
        model_ids: relevantModels.map(m => m.id),
      };
    }

    // 3. Save the aggregated data to a single JSON file
    await fs.writeFile(KEYWORD_DATA_OUTPUT_PATH, JSON.stringify(keywordPagesData, null, 2));
    console.log(`\n🎉 Keyword page data generated and saved to ${KEYWORD_DATA_OUTPUT_PATH}`);

  } catch (error) {
    console.error('❌ Failed to generate keyword page data:', error);
    process.exit(1);
  }
}

main();
