
const axios = require('axios');

async function auditHtml(url) {
    try {
        console.log(`Auditing HTML for: ${url}`);
        const res = await axios.get(url);
        const html = res.data;

        console.log("1. Checking for Mesh Hub presence...");
        const hasHub = html.includes('id="neural-mesh-hub"') || html.includes('🕸️ Neural Mesh Hub');
        console.log("Neural Mesh Hub found:", hasHub);

        console.log("2. Checking for specific Knowledge nodes...");
        const commonNodes = ['Instruction Tuning', 'Transformer', 'MMLU', 'HumanEval'];
        commonNodes.forEach(node => {
            const found = html.includes(node);
            console.log(`Node [${node}] found:`, found);
        });

        if (!hasHub) {
            console.log("\n--- HTML SNIPPET AROUND MESH SECTION ---");
            // Assuming it should be after Quick Commands or before Documentation
            const index = html.indexOf('## ⚡ Quick Commands');
            if (index !== -1) {
                console.log(html.substring(index, index + 1000));
            }
        }

    } catch (err) {
        console.error("Audit failed:", err.message);
    }
}

async function run() {
    await auditHtml('https://free2aitools.com/model/meta-llama--Llama-3-8B');
    console.log("\n-------------------\n");
    await auditHtml('https://free2aitools.com/knowledge/moe');
}

run();
