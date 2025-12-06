
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import util from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execPromise = util.promisify(exec);

// --- Configuration ---
const CONFIG = {
    DB_NAME: 'ai-nexus-db',
    BATCH_SIZE: 50, // Number of models to process in memory
    INSERT_BATCH_SIZE: 100 // Edges per INSERT statement
};

// --- URN Helpers ---
function urnModel(id) { return `urn:model:${id}`; }
function urnAuthor(name) { return `urn:author:${name}`; }
function urnTag(tag) { return `urn:tag:${tag}`; }
function urnRepo(url) { return `urn:repo:${url.replace('https://github.com/', '')}`; }
function urnPaper(id) { return `urn:paper:${id}`; }
function urnDataset(name) { return `urn:dataset:${name}`; }
function urnBenchmark(name) { return `urn:benchmark:${name}`; }
function urnTask(name) { return `urn:task:${name}`; }
function urnCategory(cat) { return `urn:category:${cat}`; }

// --- Helpers ---
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isRemote = args.includes('--remote');
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : null;

async function executeD1(sql, useJson = false, useCommand = false) {
    // If useCommand is true, we pass the SQL directly via --command
    // Otherwise we use a temporary file (better for large SQL or batch inserts)

    let command;
    let tempFile = null;

    const targetFlag = isRemote ? '--remote' : '--local';
    const jsonFlag = useJson ? '--json' : '';

    if (useCommand) {
        // Simple escaping for Windows PowerShell/CMD: wrap in quotes, escape internal quotes?
        // For simple SELECTs this is usually fine.
        command = `npx wrangler d1 execute ${CONFIG.DB_NAME} ${targetFlag} ${jsonFlag} --command "${sql}"`;
    } else {
        tempFile = path.join(__dirname, `temp_graph_${Date.now()}_${Math.random().toString(36).substring(7)}.sql`);
        fs.writeFileSync(tempFile, sql);
        command = `npx wrangler d1 execute ${CONFIG.DB_NAME} ${targetFlag} ${jsonFlag} --file "${tempFile}"`;
    }

    try {
        // Increase maxBuffer to 50MB to handle large JSON output
        const { stdout } = await execPromise(command, { maxBuffer: 1024 * 1024 * 50 });
        if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        return stdout;
    } catch (error) {
        if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        throw error;
    }
}

async function fetchModels(limit = null, offset = 0) {
    const limitClause = limit ? `LIMIT ${limit}` : 'LIMIT 1000'; // Default chunk size
    const offsetClause = offset ? `OFFSET ${offset}` : '';
    const sql = `SELECT * FROM models ${limitClause} ${offsetClause}`;

    console.log(`Executing SQL (JSON mode): ${sql}`);
    try {
        // Use --command for SELECT to ensure we get results back
        const output = await executeD1(sql, true, true);

        const jsonStart = output.indexOf('[');
        if (jsonStart === -1) {
            console.warn("No JSON array found in output:", output.substring(0, 200));
            return [];
        }

        const jsonStr = output.substring(jsonStart);
        const parsed = JSON.parse(jsonStr);

        if (!Array.isArray(parsed)) {
            console.warn("Parsed JSON is not an array");
            return [];
        }

        // Iterate to find the result set that contains actual data
        for (const item of parsed) {
            if (item.results && Array.isArray(item.results) && item.results.length > 0) {
                // Check if the first result looks like a model (has 'id')
                // NOT stats like "Total queries executed"
                const sample = item.results[0];
                if (sample.id || sample.name || sample.source_url) {
                    return item.results;
                }
            }
        }

        console.warn("No valid model data found in any result set.");
        return [];
    } catch (e) {
        console.error("Failed to fetch models:", e);
        return [];
    }
}

function parseJSONField(value, fallback) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function generateEdges(model) {
    const edges = [];
    const mUrn = urnModel(model.id);

    // 1. Author
    if (model.author) {
        edges.push({ source: mUrn, target: urnAuthor(model.author), type: 'authored_by' });
        // Reciprocal? Maybe implies 'owns'
        edges.push({ source: urnAuthor(model.author), target: mUrn, type: 'authored_model' });
    }

    // 2. Tags & Pipeline
    const tags = parseJSONField(model.tags, []);
    if (model.pipeline_tag) tags.push(model.pipeline_tag);

    tags.forEach(tag => {
        edges.push({ source: mUrn, target: urnTag(tag), type: 'has_tag' });
    });

    // 3. GitHub
    if (model.source_url && model.source_url.includes('github.com')) {
        const repoUrn = urnRepo(model.source_url);
        edges.push({ source: mUrn, target: repoUrn, type: 'code_for' });
        // Reciprocal
        edges.push({ source: repoUrn, target: mUrn, type: 'implements_model' });
    }

    // 4. ArXiv
    if (model.arxiv_id) {
        const pUrn = urnPaper(model.arxiv_id);
        edges.push({ source: mUrn, target: pUrn, type: 'cited_by' }); // Model cites paper? Or described in?
        edges.push({ source: pUrn, target: mUrn, type: 'describes_model' });

        if (model.arxiv_category) {
            edges.push({ source: pUrn, target: urnCategory(model.arxiv_category), type: 'in_category' });
        }
    }

    // 5. Papers With Code
    const datasets = parseJSONField(model.pwc_datasets, []);
    datasets.forEach(ds => {
        edges.push({ source: mUrn, target: urnDataset(ds), type: 'trained_on' }); // Or evaluated_on
    });

    const tasks = parseJSONField(model.pwc_tasks, []);
    tasks.forEach(task => {
        edges.push({ source: mUrn, target: urnTask(task), type: 'performs_task' });
    });

    const benchmarks = parseJSONField(model.pwc_benchmarks, []);
    benchmarks.forEach(bm => {
        if (bm.name) {
            edges.push({ source: mUrn, target: urnBenchmark(bm.name), type: 'evaluated_on' });
        }
    });

    return edges;
}

async function bulkInsertEdges(edges) {
    if (edges.length === 0) return;

    console.log(`Prepared ${edges.length} edges for insertion...`);
    if (isDryRun) {
        console.log("(Dry Run) Skipping insert.");
        return;
    }

    // Chunk the inserts
    for (let i = 0; i < edges.length; i += CONFIG.INSERT_BATCH_SIZE) {
        const chunk = edges.slice(i, i + CONFIG.INSERT_BATCH_SIZE);
        const values = chunk.map(e => {
            const s = e.source.replace(/'/g, "''");
            const t = e.target.replace(/'/g, "''");
            const tp = e.type.replace(/'/g, "''");
            return `('${s}', '${t}', '${tp}', 1.0)`;
        }).join(',');

        const sql = `
            INSERT INTO graph_edges (source, target, type, weight)
            VALUES ${values}
            ON CONFLICT(source, target, type) DO NOTHING;
        `;
        // ON CONFLICT DO NOTHING - simple idempotency

        await executeD1(sql);
        process.stdout.write('.');
    }
    process.stdout.write('\n');
}

async function main() {
    console.log(`🚀 Starting Knowledge Graph Builder...`);
    console.log(`   Config: Limit=${limit || 'ALL'}, DryRun=${isDryRun}, Remote=${isRemote}`);

    let offset = 0;
    let totalEdges = 0;

    while (true) {
        // Fetch chunk
        const chunkLimit = limit ? Math.min(limit - offset, 100) : 100;
        if (chunkLimit <= 0) break;

        console.log(`📦 Fetching models (Offset: ${offset}, Limit: ${chunkLimit})...`);
        const models = await fetchModels(chunkLimit, offset);

        if (models.length === 0) break;

        let batchEdges = [];
        for (const model of models) {
            const edges = generateEdges(model);
            batchEdges.push(...edges);
        }

        await bulkInsertEdges(batchEdges);
        totalEdges += batchEdges.length;
        offset += models.length;

        if (models.length < 100) break; // End of data
    }

    console.log(`✅ Graph Build Complete. Total Edges: ${totalEdges}`);
}

main().catch(console.error);
