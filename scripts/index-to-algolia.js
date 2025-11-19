import algoliasearch from 'algoliasearch';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configuration ---
const ALGOLIA_APP_ID = process.env.ALGOLIA_APP_ID;
const ALGOLIA_ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY;
const ALGOLIA_INDEX_NAME = process.env.PUBLIC_ALGOLIA_INDEX_NAME || 'ai_models';

const MODELS_FILE_PATH = path.join(__dirname, '../src/data/models.json');

async function main() {
  if (!ALGOLIA_APP_ID || !ALGOLIA_ADMIN_KEY) {
    console.warn('⚠️ Algolia App ID or Admin Key not found in environment variables. Skipping indexing.');
    if (process.env.CI) {
      return;
    }
    process.exit(1);
  }

  console.log('🚀 Starting Algolia indexing...');

  try {
    const client = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_ADMIN_KEY);
    const index = client.initIndex(ALGOLIA_INDEX_NAME);

    const modelsJson = await fs.readFile(MODELS_FILE_PATH, 'utf-8');
    const models = JSON.parse(modelsJson).map(model => ({
      objectID: model.id,
      ...model
    }));

    console.log(`- Clearing existing index "${ALGOLIA_INDEX_NAME}"...`);
    await index.clearObjects();
    console.log(`- Indexing ${models.length} models...`);
    await index.saveObjects(models);

    console.log('✅ Algolia indexing completed successfully!');
  } catch (error) {
    console.error('❌ Algolia indexing failed:', error);
    process.exit(1);
  }
}

main();