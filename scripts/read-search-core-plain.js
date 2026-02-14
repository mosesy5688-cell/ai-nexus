
import https from 'https';

const url = 'https://cdn.free2aitools.com/cache/search-core.json.gz';

https.get(url, (res) => {
    const chunks = [];
    res.on('data', d => chunks.push(d));
    res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        try {
            const data = buffer.toString();
            const json = JSON.parse(data);
            const items = Array.isArray(json) ? json : (json.entities || json.models || []);
            console.log('\n=== SEARCH CORE (PLAIN TEXT) ===');
            console.log('Total Items:', items.length);
            for (let i = 0; i < Math.min(20, items.length); i++) {
                const it = items[i];
                console.log(`- ID: ${it.id}, Name: ${it.name}, Type: ${it.type}`);
            }

            const llama = items.find(it => it.id?.toLowerCase().includes('llama-3-8b') || it.slug?.toLowerCase().includes('llama-3-8b'));
            if (llama) {
                console.log('\nFound Llama:');
                console.log(JSON.stringify(llama, null, 2));
            }
        } catch (e) {
            console.error('Parse failed:', e.message);
            console.log('Sample start:', buffer.slice(0, 100).toString());
        }
    });
});
