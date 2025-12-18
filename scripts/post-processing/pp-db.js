import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function fetchAllModelsFromD1() {
    console.log('📦 Fetching all models from D1...');
    try {
        const cmd = `npx wrangler d1 execute ai-nexus-db --remote --command "SELECT id, slug, name, author, description, tags, pipeline_tag, likes, downloads, slug, last_updated FROM models" --json`;
        const output = execSync(cmd, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }); // 50MB buffer
        const parsed = JSON.parse(output);

        if (parsed && parsed.length > 0 && parsed[0].results) {
            return parsed[0].results.map(row => {
                try { row.tags = JSON.parse(row.tags); } catch (e) { row.tags = []; }
                try { row.related_ids = JSON.parse(row.related_ids); } catch (e) { row.related_ids = []; }
                return row;
            });
        }
        return [];
    } catch (error) {
        console.error('❌ Failed to fetch from D1:', error.message);
        process.exit(1);
    }
}

export async function updateD1(models) {
    console.log('💾 Updating D1 with calculated fields (tags, scores, related)...');

    const BATCH_SIZE = 50;
    const MAX_RETRIES = 3;
    const INITIAL_DELAY = 2000;

    async function executeWithRetry(cmd, retries = 0) {
        try {
            execSync(cmd, { encoding: 'utf-8' });
            return true;
        } catch (e) {
            if (e.message.includes('503') && retries < MAX_RETRIES) {
                const delay = INITIAL_DELAY * Math.pow(2, retries);
                console.warn(`⚠️  D1 API unavailable (503). Retrying in ${delay}ms... (${retries + 1}/${MAX_RETRIES})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return executeWithRetry(cmd, retries + 1);
            }
            throw e;
        }
    }

    for (let i = 0; i < models.length; i += BATCH_SIZE) {
        const batch = models.slice(i, i + BATCH_SIZE);
        const statements = batch.map(m => {
            const tagsJson = JSON.stringify(m.tags).replace(/'/g, "''");
            const relatedJson = JSON.stringify(m.related_ids).replace(/'/g, "''");
            const isRising = m.is_rising_star ? 1 : 0;
            return `UPDATE models SET tags='${tagsJson}', related_ids='${relatedJson}', is_rising_star=${isRising} WHERE id='${m.id}';`;
        }).join('\n');

        const tempSqlPath = path.join(__dirname, 'temp_update.sql');
        fs.writeFileSync(tempSqlPath, statements);

        try {
            await executeWithRetry(`npx wrangler d1 execute ai-nexus-db --remote --file=${tempSqlPath}`);
            console.log(`✅ Updated batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(models.length / BATCH_SIZE)}`);
        } catch (e) {
            console.error(`❌ Failed to update batch ${i} after ${MAX_RETRIES} retries:`, e.message);
        } finally {
            if (fs.existsSync(tempSqlPath)) {
                fs.unlinkSync(tempSqlPath);
            }
        }
    }
}
