
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

async function executeD1(sql) {
    const tempFile = path.join(__dirname, `temp_graph_${Date.now()}_${Math.random().toString(36).substring(7)}.sql`);
    fs.writeFileSync(tempFile, sql);

    const targetFlag = isRemote ? '--remote' : '--local';
    const command = `npx wrangler d1 execute ${CONFIG.DB_NAME} ${targetFlag} --file "${tempFile}"`;

    try {
        const { stdout } = await execPromise(command);
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        return stdout;
    } catch (error) {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        throw error;
    }
}

async function fetchModels(limit = null, offset = 0) {
    const limitClause = limit ? `LIMIT ${limit}` : 'LIMIT 1000'; // Default chunk size
    const offsetClause = offset ? `OFFSET ${offset}` : '';
    const sql = `SELECT * FROM models ${limitClause} ${offsetClause};`;

    // We need to parse the table output from Wrangler, OR better: use JSON output if possible?
    // Wrangler d1 execute doesn't output JSON easily via CLI for SELECTs without formatting issues.
    // For reliability in this script, we'll assume we can get a JSON array if we format the SQLite query to output JSON.
    // SQLite's json_group_array and json_object are perfect for this.

    // NOTE: This relies on SQLite JSON extension which D1 supports.
    const jsonSql = `
        SELECT json_group_array(
            json_object(
                'id', id,
                'name', name,
                'author', author,
                'tags', tags,
                'pipeline_tag', pipeline_tag,
                'source_url', source_url,
                'arxiv_id', arxiv_id,
                'arxiv_category', arxiv_category,
                'pwc_benchmarks', pwc_benchmarks,
                'pwc_tasks', pwc_tasks,
                'pwc_datasets', pwc_datasets
            )
        ) as data FROM (SELECT * FROM models ${limitClause} ${offsetClause});
    `;

    const output = await executeD1(jsonSql);
    // Parse the output. Wrangler output usually contains a table or the raw string.
    // We look for the JSON array bracket `[`
    const jsonStart = output.indexOf('[');
    const jsonEnd = output.lastIndexOf(']') + 1;

    if (jsonStart === -1 || jsonEnd === 0) return [];

    try {
        const jsonStr = output.substring(jsonStart, jsonEnd);
        return JSON.parse(jsonStr);
    } catch (e) {
        console.error("Failed to parse D1 JSON output:", e);
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
