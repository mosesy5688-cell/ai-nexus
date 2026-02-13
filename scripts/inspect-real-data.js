
import { createGunzip } from 'zlib';
import https from 'https';
import { pipeline } from 'stream';
import { promisify } from 'util';

const url = 'https://cdn.free2aitools.com/cache/fused/arxiv-paper--2010.06746.json.gz';

console.log(`Fetching ${url}...`);

https.get(url, (res) => {
    if (res.statusCode !== 200) {
        console.error(`Failed to fetch: ${res.statusCode}`);
        return;
    }

    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        console.log(`Downloaded ${buffer.length} bytes.`);

        try {
            // Isomorphic gzip handling
            // Since we are in Node, we can use zlib sync for simplicity in this script
            import('zlib').then(({ gunzipSync }) => {
                try {
                    const decoded = gunzipSync(buffer);
                    const json = JSON.parse(decoded.toString());

                    console.log('\n=== DATA INSPECTION ===');
                    console.log('Keys:', Object.keys(json));
                    console.log('ID:', json.id);
                    console.log('Slug:', json.slug);
                    if (json.entity) {
                        console.log('Entity.ID:', json.entity.id);
                        console.log('Entity.Slug:', json.entity.slug);
                    }
                } catch (e) {
                    console.log('Gunzip failed, trying raw JSON...');
                    const json = JSON.parse(buffer.toString());
                    console.log('\n=== DATA INSPECTION (Raw JSON) ===');
                    console.log('ID:', json.id);
                }
            });

        } catch (e) {
            console.error('Processing failed:', e.message);
        }
    });
});
