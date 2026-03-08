
import { fetchCatalogData } from './src/utils/catalog-fetcher.js';

async function test() {
    console.log('Fetching model data...');
    // We mock the runtime environment if needed, but fetchCatalogData should handle null
    const result = await fetchCatalogData('model');
    console.log(`Source: ${result.source}`);
    console.log(`Total: ${result.totalEntities}`);
    if (result.items.length > 0) {
        console.log('First Item:');
        console.log(JSON.stringify(result.items[0], null, 2));
    } else {
        console.log('No items found!');
    }
}

test();
