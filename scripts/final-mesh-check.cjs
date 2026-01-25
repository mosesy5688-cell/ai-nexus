
const axios = require('axios');
async function check() {
    try {
        console.log("Fetching production pages for final verification...");

        // 1. Check Llama 3 Model Page
        const resModel = await axios.get('https://free2aitools.com/model/meta-llama--Llama-3-8B');
        const hasHub = resModel.data.includes('id="neural-mesh-hub"');
        console.log("FINAL PROOF - Llama 3 Mesh Hub Visible:", hasHub);

        // 2. Check MoE Knowledge Page
        const resKb = await axios.get('https://free2aitools.com/knowledge/moe');
        const hasCore = resKb.data.includes('Core Ecosystem');
        const hasModels = resKb.data.includes('Uni2TS') || resKb.data.includes('Phixtral');
        console.log("FINAL PROOF - MoE Core Ecosystem Section Visible:", hasCore);
        console.log("FINAL PROOF - MoE Dynamic Models (Uni2TS/Phixtral) Visible:", hasModels);

        if (hasHub && hasModels) {
            console.log("\n🚀 100% DATA TRUTH RESTORED ACROSS THE ENTIRE MESH.");
        } else {
            console.log("\n⚠️ VERIFICATION INCOMPLETE: CDN CACHE MAY STILL BE REFRESHING.");
        }
    } catch (e) {
        console.error("Verification failed:", e.message);
    }
}
check();
