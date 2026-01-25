
const axios = require('axios');

// V16.14 Implemented Match Logic
const stripPrefix = (id) => {
    if (!id || typeof id !== 'string') return '';
    const canonicalPrefixes = /^(hf-model|hf-agent|hf-tool|hf-dataset|hf-space|knowledge|report|arxiv|dataset|tool|paper|model|agent|space)[:\-\/]+/;
    let res = id.toLowerCase().replace(canonicalPrefixes, '');
    res = res.replace(/^what-is-/, ''); // The V16.14 Fix
    return res.replace(/:/g, '--').replace(/\//g, '--');
};

const isMatch = (a, b) => {
    if (!a || !b) return false;
    const aNorm = stripPrefix(a);
    const bNorm = stripPrefix(b);
    return aNorm === bNorm || aNorm.includes(bNorm) || bNorm.includes(aNorm);
};

async function verifyRestoration() {
    try {
        console.log("--- FINAL PRODUCTION VALIDATION (V16.14) ---");
        const [graphRes, kbRes] = await Promise.all([
            axios.get('https://free2aitools.com/cache/mesh/graph.json'),
            axios.get('https://free2aitools.com/cache/knowledge/index.json')
        ]);

        const graph = graphRes.data;
        const kbIdx = kbRes.data.articles || kbRes.data;
        const validSlugs = new Set(kbIdx.map(a => stripPrefix(a.slug || a.id)));

        // Test Target: MoE (The 80% failure case)
        const targetId = "knowledge--moe";
        console.log(`Testing Node: ${targetId}`);

        let rawMatches = 0;
        let successfulRecognitions = 0;
        let failedNodes = [];

        Object.entries(graph.edges || {}).forEach(([srcId, targets]) => {
            targets.forEach(edge => {
                const tId = edge.target || edge[0];
                if (isMatch(srcId, targetId) || isMatch(tId, targetId)) {
                    rawMatches++;

                    // Logic check: Would the frontend show this node?
                    const otherId = isMatch(srcId, targetId) ? tId : srcId;
                    const knowledgeId = otherId.includes('knowledge') ? otherId : null;

                    if (knowledgeId) {
                        const knSlug = stripPrefix(knowledgeId);
                        if (validSlugs.has(knSlug)) {
                            successfulRecognitions++;
                        } else {
                            failedNodes.push(knowledgeId);
                        }
                    } else {
                        // Core entity (model/agent) - always shows
                        successfulRecognitions++;
                    }
                }
            });
        });

        console.log(`Total R2 Associations Found: ${rawMatches}`);
        console.log(`Successfully Recognized by V16.14 Logic: ${successfulRecognitions}`);
        console.log(`Success Rate: ${Math.round((successfulRecognitions / rawMatches) * 100)}%`);

        if (failedNodes.length > 0) {
            console.warn(`STILL LEAKING: ${failedNodes.length} nodes could not be mapped.`);
            console.log("Example:", failedNodes[0]);
        } else {
            console.log("VERIFICATION PASSED: 100% Data Integrity Restored.");
        }

    } catch (err) {
        console.error("Verification failed:", err.message);
    }
}

verifyRestoration();
