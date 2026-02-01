import https from 'https';

const urls = [
    'https://cdn-thumbnails.huggingface.co/social-thumbnails/spaces/jbilcke-hf/ai-clip-factory.png',
    'https://cdn-thumbnails.huggingface.co/social-thumbnails/spaces/hadadxyz/ai.png',
    'https://cdn-thumbnails.huggingface.co/social-thumbnails/spaces/microsoft-cognitive-service/mm-react.png'
];

async function checkUrl(url) {
    return new Promise((resolve) => {
        const options = {
            timeout: 5000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'Referer': 'https://huggingface.co/'
            }
        };

        https.get(url, options, (res) => {
            console.log(`📡 URL: ${url}`);
            console.log(`   Status: ${res.statusCode}`);
            resolve(res.statusCode === 200);
        }).on('error', (err) => {
            console.log(`❌ Error: ${err.message}`);
            resolve(false);
        });
    });
}

(async () => {
    console.log('🧪 Testing Visual Engine Patch (V16.7.1)...');
    for (const url of urls) {
        await checkUrl(url);
    }
    console.log('✅ Test finished');
})();
