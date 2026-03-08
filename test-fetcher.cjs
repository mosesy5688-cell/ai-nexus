
const { fetchCatalogData } = require('./src/utils/catalog-fetcher.js');

async function test() {
    try {
        console.log('Fetching model data...');
        const result = await fetchCatalogData('model');
        console.log(`Source: ${result.source}`);
        console.log(`Total: ${result.totalEntities}`);
        if (result.items.length > 0) {
            console.log('First Item FNI:', result.items[0].fni_score);
            console.log('Raw sample:', JSON.stringify(result.items[0], null, 2));
        } else {
            console.log('No items found!');
        }
    } catch (e) {
        console.error('Test failed:', e);
    }
}

test();
