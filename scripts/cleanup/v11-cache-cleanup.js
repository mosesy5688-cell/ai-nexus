/**
 * V11 Old Cache Cleanup Script
 * Removes legacy cache paths after V11 migration completes
 * Safe to run: Lists files first, requires confirmation to delete
 * @module scripts/cleanup/v11-cache-cleanup
 */
import { execSync } from 'child_process';
import readline from 'readline';

const R2_BUCKET = 'ai-nexus-assets';
const OLD_PATHS = [
    'cache/models/',           // Old model cache path
    'cache/datasets/',         // Old dataset cache path (if any)
    'ingest/batches/',         // Old ingest batches
];

async function listFilesToClean() {
    console.log('🔍 V11 Cache Cleanup - Scanning old paths...\n');
    const filesToDelete = [];

    for (const prefix of OLD_PATHS) {
        console.log(`📁 Checking: ${prefix}`);
        try {
            const result = execSync(
                `npx wrangler r2 object list ${R2_BUCKET} --prefix="${prefix}" --json`,
                { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
            );
            const objects = JSON.parse(result);
            if (objects.length > 0) {
                console.log(`   Found ${objects.length} objects`);
                filesToDelete.push(...objects.map(o => o.key));
            } else {
                console.log('   No objects found (already clean)');
            }
        } catch (e) {
            console.log(`   ⚠️ Error: ${e.message}`);
        }
    }

    return filesToDelete;
}

async function confirmDelete(files) {
    if (files.length === 0) {
        console.log('\n✅ No old cache files to clean. Already migrated!');
        return false;
    }

    console.log(`\n📊 Total files to delete: ${files.length}`);
    console.log('\n⚠️ This action cannot be undone!');
    console.log('Sample files:');
    files.slice(0, 5).forEach(f => console.log(`   - ${f}`));
    if (files.length > 5) console.log(`   ... and ${files.length - 5} more`);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question('\nProceed with deletion? (yes/no): ', answer => {
            rl.close();
            resolve(answer.toLowerCase() === 'yes');
        });
    });
}

async function deleteFiles(files) {
    console.log('\n🗑️ Deleting old cache files...');
    let deleted = 0, failed = 0;

    for (const file of files) {
        try {
            execSync(`npx wrangler r2 object delete ${R2_BUCKET} "${file}"`, { stdio: 'pipe' });
            deleted++;
            if (deleted % 100 === 0) console.log(`   Progress: ${deleted}/${files.length}`);
        } catch (e) {
            failed++;
        }
    }

    console.log(`\n✅ Cleanup complete: ${deleted} deleted, ${failed} failed`);
}

async function main() {
    console.log('🧹 V11 Old Cache Cleanup\n');
    const dryRun = process.argv.includes('--dry-run');

    const files = await listFilesToClean();

    if (dryRun) {
        console.log('\n📋 DRY RUN - No files deleted');
        console.log(`Would delete ${files.length} files`);
        return;
    }

    if (await confirmDelete(files)) {
        await deleteFiles(files);
    } else {
        console.log('\n❌ Cleanup cancelled');
    }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
