
import https from 'https';
import { createGunzip } from 'zlib';

const url = 'https://cdn.free2aitools.com/cache/trending.json.gz';

console.log(`Fetching ${url}...`);

https.get(url, (res) => {
    const chunks = [];
    res.on('data', d => chunks.push(d));
    res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        import('zlib').then(({ gunzipSync }) => {
            try {
                const data = gunzipSync(buffer);
                const json = JSON.parse(data.toString());
                console.log('\n=== TRENDING DATA INSPECTION ===');
                console.log('Total Models:', json.models?.length);
                if (json.models?.length > 0) {
                    const m = json.models[0];
                    console.log('Sample Keys:', Object.keys(m));
                    console.log('Sample ID:', m.id);
                    console.log('Sample Slug:', m.slug);
                    console.log('Sample Name:', m.name);
                }
            } catch (e) {
                console.log('Gunzip failed, trying raw JSON...');
                try {
                    const json = JSON.parse(buffer.toString());
                    console.log('Total Models (Raw):', json.models?.length);
                } catch (e2) {
                    console.error('Parse failed:', e2.message);
                }
            }
        });
    });
});
