/**
 * R2 Upload with Checkpoint Recovery
 * V14.4 Phoenix Protocol
 * 
 * - Wrangler R2 limit: 5GB per file
 * - Checkpoint recovery: checkpoint.json
 * - Non-destructive: PUT only, never DELETE
 * 
 * Constitutional: Art 13.4 (Non-Destructive)
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const BUCKET = 'ai-nexus-assets';
const OUTPUT_DIR = './output';
const CHECKPOINT_FILE = './upload-checkpoint.json';

// Load checkpoint
function loadCheckpoint() {
    if (fs.existsSync(CHECKPOINT_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf-8'));
        } catch (e) {
            console.warn('⚠️ Invalid checkpoint, starting fresh');
        }
    }
    return { uploaded: [], timestamp: Date.now() };
}

// Save checkpoint
function saveCheckpoint(checkpoint) {
    checkpoint.timestamp = Date.now();
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
}

// Get all files recursively
function getAllFiles(dir, files = []) {
    if (!fs.existsSync(dir)) {
        console.error(`❌ Directory not found: ${dir}`);
        return files;
    }

    const items = fs.readdirSync(dir);
    for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            getAllFiles(fullPath, files);
        } else {
            files.push({
                path: fullPath,
                size: stat.size
            });
        }
    }
    return files;
}

// Upload single file (using npx wrangler)
// V14.5: Added verbose logging for debugging upload failures
function uploadFile(localPath, remotePath, debug = false) {
    try {
        // Use npx to run wrangler without global install
        // V14.5: Added --remote flag to ensure upload to actual R2 (not local emulator)
        const result = execSync(`npx wrangler r2 object put "${BUCKET}" "${remotePath}" --file="${localPath}" --remote`, {
            stdio: debug ? 'inherit' : 'pipe', // Show output for first few files
            timeout: 60000, // 60s timeout
            encoding: 'utf-8'
        });
        return true;
    } catch (e) {
        console.error(`\n❌ Failed: ${localPath}`);
        console.error(`   Error: ${e.message}`);
        if (e.stderr) console.error(`   Stderr: ${e.stderr}`);
        return false;
    }
}

async function main() {
    console.log('📤 V14.4 Phoenix Protocol - R2 Upload');
    console.log('=====================================');

    // Check environment variables
    if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
        console.error('❌ ERROR: Missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID');
        process.exit(1);
    }

    const checkpoint = loadCheckpoint();
    const uploadedSet = new Set(checkpoint.uploaded);
    const allFiles = getAllFiles(OUTPUT_DIR);

    console.log(`📊 Total files: ${allFiles.length}`);
    console.log(`📊 Already uploaded: ${uploadedSet.size}`);
    console.log(`📊 Remaining: ${allFiles.length - uploadedSet.size}`);

    // Calculate total size
    const totalSize = allFiles.reduce((sum, f) => sum + f.size, 0);
    console.log(`📊 Total size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);

    let success = 0;
    let fail = 0;
    let skipped = 0;

    for (let i = 0; i < allFiles.length; i++) {
        const file = allFiles[i];
        // V14.4 Fix: Properly strip output directory prefix for R2 path
        // Handle both ./output/ and output/ formats (Windows vs Linux)
        let remotePath = file.path.replace(/\\/g, '/'); // Normalize to forward slashes
        remotePath = remotePath.replace(/^\.?\/?(output\/)?/, ''); // Strip output/ prefix

        // Skip already uploaded files
        if (uploadedSet.has(remotePath)) {
            skipped++;
            continue;
        }

        // Show progress
        const progress = ((i + 1) / allFiles.length * 100).toFixed(1);
        process.stdout.write(`\r[${progress}%] Uploading: ${remotePath.substring(0, 50)}...`);

        // V14.5: Debug first 3 uploads to capture any wrangler errors
        const debugMode = (i < 3);
        if (uploadFile(file.path, remotePath, debugMode)) {
            checkpoint.uploaded.push(remotePath);
            success++;

            // Save checkpoint every 100 files
            if (success % 100 === 0) {
                saveCheckpoint(checkpoint);
                console.log(`\n💾 Checkpoint saved: ${success} files uploaded`);
            }
        } else {
            fail++;
        }
    }

    // Final checkpoint save
    saveCheckpoint(checkpoint);

    console.log('\n');
    console.log('=====================================');
    console.log('✅ Upload Complete!');
    console.log(`   Success: ${success}`);
    console.log(`   Failed: ${fail}`);
    console.log(`   Skipped (already uploaded): ${skipped}`);
    console.log('=====================================');

    // Exit with error code if any files failed
    if (fail > 0) {
        console.warn(`⚠️ ${fail} files failed to upload. Re-run to retry.`);
        process.exit(1);
    }
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
