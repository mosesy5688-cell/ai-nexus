import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

async function testD1() {
    console.log("🔄 Testing D1 Connection...");
    const dbName = "ai-nexus-db";
    const testId = "test-model-" + Date.now();
    const sql = `INSERT INTO models (id, name, author, description) VALUES ('${testId}', 'Test Model', 'Tester', 'This is a test entry from Node.js');`;

    try {
        // Use wrangler d1 execute to run the SQL
        // --remote flag ensures we are talking to the real D1
        const command = `npx wrangler d1 execute ${dbName} --remote --command "${sql}"`;
        console.log(`Running: ${command}`);

        const { stdout, stderr } = await execPromise(command);

        console.log("✅ D1 Insert Success!");
        console.log(stdout);

        if (stderr) console.error("⚠️ Stderr:", stderr);

    } catch (error) {
        console.error("❌ D1 Test Failed:", error.message);
        if (error.stdout) console.log("Stdout:", error.stdout);
        if (error.stderr) console.error("Stderr:", error.stderr);
    }
}

testD1();
