
// Native fetch in Node 20

const BASE_URL = 'https://cdn.free2aitools.com';
const TARGET_SLUG = '0x4m4/hexstrike-ai';
const TARGET_ID_PURE = '0x4m4--hexstrike-ai';

const CANDIDATES = [
    // Fused Paths (Primary)
    `/cache/fused/hf-agent--${TARGET_ID_PURE}.json`,
    `/cache/fused/gh-agent--${TARGET_ID_PURE}.json`,
    `/cache/fused/agent--${TARGET_ID_PURE}.json`,
    `/cache/fused/${TARGET_ID_PURE}.json`,
    // Fused Gzip
    `/cache/fused/hf-agent--${TARGET_ID_PURE}.json.gz`,
    `/cache/fused/gh-agent--${TARGET_ID_PURE}.json.gz`,

    // Entities Paths (Legacy/Fallback)
    `/cache/entities/agent/${TARGET_ID_PURE}.json`,
    `/cache/entities/agent/hf-agent--${TARGET_ID_PURE}.json`,
    `/cache/entities/agent/gh-agent--${TARGET_ID_PURE}.json`
];

async function checkUrl(path) {
    try {
        const url = `${BASE_URL}${path}`;
        const start = Date.now();
        const res = await fetch(url, { method: 'HEAD' });
        const duration = Date.now() - start;
        console.log(`[${res.status}] ${path} (${duration}ms)`);
        if (res.ok) {
            console.log(`   -> FOUND! Content-Type: ${res.headers.get('content-type')} Length: ${res.headers.get('content-length')}`);
        }
    } catch (e) {
        console.log(`[ERR] ${path}: ${e.message}`);
    }
}

console.log(`Probing R2 for ${TARGET_ID_PURE}...`);
for (const path of CANDIDATES) {
    await checkUrl(path);
}
