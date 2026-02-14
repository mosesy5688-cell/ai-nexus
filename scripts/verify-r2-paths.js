
import https from 'https';

const modelSlug = 'meta-llama--llama-3-8b';
const candidates = [
    `cache/entities/model/hf-model--${modelSlug}.json`,
    `cache/entities/model/hf-model--${modelSlug}.json.gz`,
    `cache/entities/model/${modelSlug}.json`,
    `cache/fused/hf-model--${modelSlug}.json.gz`,
    `cache/fused/${modelSlug}.json.gz`
];

async function verify() {
    for (const p of candidates) {
        const url = `https://cdn.free2aitools.com/${p}`;
        console.log(`Checking ${url}...`);
        try {
            const res = await new Promise((resolve, reject) => {
                https.get(url, (res) => resolve(res)).on('error', reject);
            });
            console.log(`Status: ${res.statusCode}`);
        } catch (e) {
            console.error(`Error: ${e.message}`);
        }
    }
}

verify();
