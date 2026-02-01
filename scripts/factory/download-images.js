import fs from 'fs';
import https from 'https';
import http from 'http';
import path from 'path';

async function downloadImage(url, dest, depth = 0) {
    if (depth > 5) throw new Error('Too many redirects');
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        const options = {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'Referer': 'https://huggingface.co/'
            }
        };
        protocol.get(url, options, (res) => {
            if (res.statusCode === 200) {
                const file = fs.createWriteStream(dest);
                res.pipe(file);
                file.on('finish', () => { file.close(); resolve(true); });
            } else if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const absoluteUrl = new URL(res.headers.location, url).toString();
                downloadImage(absoluteUrl, dest, depth + 1).then(resolve).catch(reject);
            } else {
                reject(new Error('Status: ' + res.statusCode));
            }
        }).on('error', reject);
    });
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    const queuePath = 'data/image-queue.json';
    const resultsPath = 'data/image-results.json';
    const imagesDir = 'data/images';

    if (!fs.existsSync(queuePath)) {
        console.error('❌ Queue file missing');
        process.exit(1);
    }

    const queue = JSON.parse(fs.readFileSync(queuePath, 'utf-8'));
    const results = { success: 0, failed: 0, skipped: 0 };

    for (const item of queue) {
        const safeId = item.id;
        const type = item.type || 'model';
        const destDir = path.join(imagesDir, type);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

        const destPath = path.join(destDir, safeId + '.jpg');

        try {
            if (fs.existsSync(destPath)) { results.skipped++; continue; }

            // Polite Crawling (500ms - 1500ms jitter)
            const delay = 500 + Math.random() * 1000;
            await sleep(delay);

            await downloadImage(item.source_url, destPath);
            results.success++;
            console.log(`✅ [${type}] ${safeId}`);
        } catch (err) {
            results.failed++;
            console.log(`❌ [${type}] ${safeId}: ${err.message}`);
        }
    }

    console.log('Results:', results);
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
    process.exit(0);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
