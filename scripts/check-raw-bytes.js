
import https from 'https';

const urls = [
    'https://cdn.free2aitools.com/cache/search-core.json.gz',
    'https://cdn.free2aitools.com/cache/trending.json.gz'
];

async function checkBytes() {
    for (const url of urls) {
        console.log(`\nChecking ${url}...`);
        try {
            const res = await new Promise((resolve, reject) => {
                https.get(url, (res) => resolve(res)).on('error', reject);
            });
            console.log(`Status: ${res.statusCode}`);
            if (res.statusCode === 200) {
                const chunks = [];
                for await (const chunk of res) {
                    chunks.push(chunk);
                    if (Buffer.concat(chunks).length > 20) break;
                }
                const buffer = Buffer.concat(chunks);
                console.log('First 16 bytes:', buffer.slice(0, 16).toString('hex'));
                console.log('First 16 as text:', buffer.slice(0, 16).toString());
            }
        } catch (e) {
            console.error(`Error: ${e.message}`);
        }
    }
}

checkBytes();
