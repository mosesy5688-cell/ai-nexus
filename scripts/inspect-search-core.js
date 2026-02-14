
import https from 'https';
import { gunzipSync } from 'zlib';

const url = 'https://cdn.free2aitools.com/cache/search-core.json.gz';

console.log(`Fetching ${url}...`);

https.get(url, (res) => {
    const chunks = [];
    res.on('data', d => chunks.push(d));
    res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        try {
            const data = gunzipSync(buffer);
            const json = JSON.parse(data.toString());
            const items = json.entities || json.models || json || [];
            console.log('\n=== SEARCH CORE INSPECTION ===');
            console.log('Total Items:', items.length);
            for (let i = 0; i < Math.min(10, items.length); i++) {
                const it = items[i];
                console.log(`- ID: ${it.id}, Name: ${it.name}, Type: ${it.type}`);
            }

            const llama = items.find(it => it.id?.toLowerCase().includes('llama-3-8b') || it.slug?.toLowerCase().includes('llama-3-8b'));
            if (llama) {
                console.log('\nFound Llama:');
                console.log(JSON.stringify(llama, null, 2));
            } else {
                console.log('\nLlama not found in sample/search.');
            }
        } catch (e) {
            console.error('Parse failed:', e.message);
        }
    });
});
