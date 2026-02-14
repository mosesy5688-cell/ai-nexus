
import https from 'https';

const paths = [
    'https://cdn.free2aitools.com/cache/trending.json',
    'https://cdn.free2aitools.com/cache/trending-data.json',
    'https://cdn.free2aitools.com/cache/trending-data.json.gz'
];

async function check() {
    for (const url of paths) {
        console.log(`Checking ${url}...`);
        try {
            const res = await new Promise((resolve, reject) => {
                https.get(url, (res) => resolve(res)).on('error', reject);
            });
            console.log(`Status: ${res.statusCode}, Size: ${res.headers['content-length']}`);
        } catch (e) {
            console.error(`Error checking ${url}:`, e.message);
        }
    }
}

check();
