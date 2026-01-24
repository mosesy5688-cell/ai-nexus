
import { prepareDatasetPageData } from '../src/utils/dataset-page-data.js';

async function test() {
    console.log("Starting reproduction test...");
    const locals = { runtime: { env: {} } };
    try {
        const data = await prepareDatasetPageData(['squad'], 'squad', locals);
        console.log("SUCCESS:", data ? "Data retrieved" : "No data");
    } catch (e) {
        console.error("CRASH DETECTED:");
        console.error(e);
    }
}

test();
