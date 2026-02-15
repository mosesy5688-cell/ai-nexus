import { truncateListingItem } from './src/utils/catalog-fetcher.js';

const mockItem = {
    id: 'test/item',
    name: 'Test Item',
    summary: 'This is the summary we want to see.',
    likes: 10
};

const result = truncateListingItem(mockItem);
console.log('Result Description:', result.description);

if (result.description === mockItem.summary) {
    console.log('✅ Success: Summary correctly mapped to description.');
} else {
    console.log('❌ Failure: Summary NOT mapped.');
    process.exit(1);
}
