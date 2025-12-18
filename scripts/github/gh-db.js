/**
 * GitHub Enrichment Database & Checkpoint Utils
 */
import fs from 'fs';
import path from 'path';
import util from 'util';
import { exec } from 'child_process';
import { fileURLToPath } from 'url'; // Added missing import
import { CONFIG, sleep } from './gh-config.js';

const execPromise = util.promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Checkpoint Management
 */
export function loadCheckpoint() {
    if (fs.existsSync(CONFIG.CHECKPOINT_FILE)) {
        try {
            const data = fs.readFileSync(CONFIG.CHECKPOINT_FILE, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            console.warn('⚠️  Failed to load checkpoint, starting fresh');
            return { processedIds: [] };
        }
    }
    return { processedIds: [] };
}

export function saveCheckpoint(checkpoint) {
    try {
        fs.writeFileSync(CONFIG.CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
    } catch (error) {
        console.error('❌ Failed to save checkpoint:', error.message);
    }
}

export function clearCheckpoint() {
    if (fs.existsSync(CONFIG.CHECKPOINT_FILE)) {
        fs.unlinkSync(CONFIG.CHECKPOINT_FILE);
    }
}

/**
 * D1 Interaction with Retry
 */
export async function executeD1WithRetry(sql, isRemote, maxRetries = CONFIG.MAX_RETRIES) {
    const tempFile = path.join(__dirname, `temp_enrich_${Date.now()}.sql`);
    fs.writeFileSync(tempFile, sql);

    const targetFlag = isRemote ? '--remote' : '--local';
    const command = `npx wrangler d1 execute ${CONFIG.DB_NAME} ${targetFlag} --file "${tempFile}"`;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const { stdout } = await execPromise(command);
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            return stdout;
        } catch (error) {
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);

            if (attempt === maxRetries - 1) throw error;

            const backoffTime = CONFIG.INITIAL_BACKOFF_MS * Math.pow(2, attempt);
            console.log(`⚠️  Retry ${attempt + 1}/${maxRetries} after ${backoffTime}ms...`);
            await sleep(backoffTime);
        }
    }
}

export async function queryD1WithRetry(sql, isRemote, maxRetries = CONFIG.MAX_RETRIES) {
    const targetFlag = isRemote ? '--remote' : '--local';
    const singleLineSQL = sql.replace(/\s+/g, ' ').trim();
    const escapedSQL = singleLineSQL.replace(/"/g, '\\"');
    const command = `npx wrangler d1 execute ${CONFIG.DB_NAME} ${targetFlag} --json --command="${escapedSQL}"`;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const { stdout } = await execPromise(command);
            const jsonStart = stdout.indexOf('[');
            const jsonEnd = stdout.lastIndexOf(']') + 1;

            if (jsonStart === -1 || jsonEnd === 0) {
                throw new Error('No JSON found in response');
            }

            const jsonStr = stdout.substring(jsonStart, jsonEnd);
            const result = JSON.parse(jsonStr);
            return result[0]?.results || [];
        } catch (error) {
            if (attempt === maxRetries - 1) throw error;

            const backoffTime = CONFIG.INITIAL_BACKOFF_MS * Math.pow(2, attempt);
            console.log(`⚠️  Query retry ${attempt + 1}/${maxRetries} after ${backoffTime}ms...`);
            await sleep(backoffTime);
        }
    }
}

export async function updateModelGitHubData(modelId, githubData, isRemote, isDryRun) {
    const escapedId = modelId.replace(/'/g, "''");
    const escapedCommit = (githubData.github_last_commit || '').replace(/'/g, "''");

    const sql = `
        UPDATE models
        SET github_stars = ${githubData.github_stars},
            github_forks = ${githubData.github_forks},
            github_last_commit = ${githubData.github_last_commit ? `'${escapedCommit}'` : 'NULL'},
            github_contributors = ${githubData.github_contributors || 0}
        WHERE id = '${escapedId}';
    `;

    if (!isDryRun) {
        await executeD1WithRetry(sql, isRemote);
    }
}
