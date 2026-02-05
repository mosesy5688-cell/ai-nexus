/**
 * verify-registry-format.js
 * 
 * Tooling to prevent "Registry Load Failure" by checking if the 
 * global-registry.json is a valid object and not a raw array.
 */
import fs from 'fs/promises';
import path from 'path';

async function verify() {
    const registryPath = path.join(process.cwd(), 'cache', 'global-registry.json');

    try {
        const content = await fs.readFile(registryPath, 'utf-8');
        const data = JSON.parse(content);

        if (Array.isArray(data)) {
            console.error('❌ Registry Format Violation: Found raw array instead of registry object!');
            process.exit(1);
        }

        if (!data.entities || !Array.isArray(data.entities)) {
            console.error('❌ Registry Content Violation: Missing or invalid "entities" array.');
            process.exit(1);
        }

        console.log(`✅ Registry Format Verified: Object detected with ${data.entities.length} entities.`);
        process.exit(0);

    } catch (err) {
        if (err.code === 'ENOENT') {
            console.log('⚠️ No monolith found (OK if using shards).');
            process.exit(0);
        }
        console.error(`❌ Verification Error: ${err.message}`);
        process.exit(1);
    }
}

verify();
