/**
 * V25.8 Term Registry Manager
 *
 * Manages `term-registry.db` for alias mapping and TF-IDF linking.
 * Maps aliases like "MoE" -> "Mixture of Experts" for mesh connectivity.
 *
 * Linking Threshold: TF-IDF > 0.4 required for dynamic mesh connection.
 * Graph Safety: MAX_RELATIONS_PER_NODE = 20.
 */

import Database from 'better-sqlite3';
import fs from 'fs/promises';
import path from 'path';
import { setupDatabasePragmas } from './pack-utils.js';

const OUTPUT_DIR = process.env.OUTPUT_DIR || './output/data';
const MAX_RELATIONS = 20;
const TFIDF_THRESHOLD = 0.4;

const TERM_SCHEMA = `
    CREATE TABLE terms (
        canonical TEXT PRIMARY KEY,
        aliases TEXT,
        category TEXT,
        weight REAL DEFAULT 1.0
    );
    CREATE TABLE term_links (
        source_id TEXT,
        target_id TEXT,
        term TEXT,
        tfidf_score REAL,
        PRIMARY KEY (source_id, target_id, term)
    );
    CREATE INDEX idx_links_source ON term_links(source_id);
    CREATE INDEX idx_links_target ON term_links(target_id);
`;

/** Default term registry with common AI aliases */
const DEFAULT_TERMS = [
    { canonical: 'mixture-of-experts', aliases: 'MoE,moe,mixture of experts,sparse moe', category: 'architecture' },
    { canonical: 'retrieval-augmented-generation', aliases: 'RAG,rag,retrieval augmented', category: 'technique' },
    { canonical: 'reinforcement-learning-human-feedback', aliases: 'RLHF,rlhf', category: 'training' },
    { canonical: 'direct-preference-optimization', aliases: 'DPO,dpo', category: 'training' },
    { canonical: 'quantization', aliases: 'GPTQ,gptq,AWQ,awq,INT4,INT8,GGUF,gguf', category: 'optimization' },
    { canonical: 'transformer', aliases: 'transformer,attention mechanism,self-attention', category: 'architecture' },
    { canonical: 'fine-tuning', aliases: 'finetuning,fine-tuned,LoRA,lora,QLoRA,qlora,PEFT', category: 'training' },
    { canonical: 'long-context', aliases: 'long context,context window,128k,1m context', category: 'capability' },
    { canonical: 'multimodal', aliases: 'vision-language,VLM,vlm,image-text,audio-text', category: 'capability' },
    { canonical: 'code-generation', aliases: 'code gen,code completion,copilot,codegen', category: 'task' },
    { canonical: 'embedding', aliases: 'embeddings,vector embedding,sentence embedding', category: 'technique' },
    { canonical: 'inference-optimization', aliases: 'vLLM,TGI,speculative decoding,KV cache', category: 'optimization' },
    { canonical: 'agentic', aliases: 'agent,agentic workflow,tool use,function calling', category: 'paradigm' },
];

/**
 * Compute simple TF-IDF score for a term in entity text.
 */
function computeTfIdf(term, entityText, totalDocs, docsWithTerm) {
    const words = entityText.toLowerCase().split(/\s+/);
    const termLower = term.toLowerCase();
    const tf = words.filter(w => w.includes(termLower)).length / Math.max(1, words.length);
    const idf = Math.log(totalDocs / Math.max(1, docsWithTerm));
    return tf * idf;
}

/**
 * Build or rebuild term-registry.db
 */
export async function buildTermRegistry(entities = []) {
    console.log('[TERM-REGISTRY] Building term-registry.db...');
    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    const dbPath = path.join(OUTPUT_DIR, 'term-registry.db');
    const db = new Database(dbPath);
    setupDatabasePragmas(db);
    db.exec(TERM_SCHEMA);

    // Insert canonical terms
    const insertTerm = db.prepare('INSERT OR REPLACE INTO terms VALUES (?, ?, ?, ?)');
    db.exec('BEGIN TRANSACTION');
    for (const t of DEFAULT_TERMS) {
        insertTerm.run(t.canonical, t.aliases, t.category, 1.0);
    }
    db.exec('COMMIT');
    console.log(`  Loaded ${DEFAULT_TERMS.length} canonical terms`);

    if (entities.length === 0) {
        db.exec('VACUUM;');
        db.close();
        return;
    }

    // Build term-entity links via TF-IDF
    const insertLink = db.prepare('INSERT OR REPLACE INTO term_links VALUES (?, ?, ?, ?)');
    const totalDocs = entities.length;

    // Pre-compute doc frequency for each term alias
    const docFreqs = new Map();
    for (const t of DEFAULT_TERMS) {
        const aliases = t.aliases.split(',').map(a => a.trim().toLowerCase());
        let count = 0;
        for (const entity of entities) {
            const text = [entity.name, entity.summary, entity.description, ...(entity.tags || [])].join(' ').toLowerCase();
            if (aliases.some(a => text.includes(a))) count++;
        }
        docFreqs.set(t.canonical, count);
    }

    db.exec('BEGIN TRANSACTION');
    let linkCount = 0;

    for (const entity of entities) {
        const id = entity.id || entity.slug;
        if (!id) continue;

        const text = [entity.name, entity.summary, entity.description, ...(entity.tags || [])].join(' ');
        let entityLinks = 0;

        for (const t of DEFAULT_TERMS) {
            if (entityLinks >= MAX_RELATIONS) break;

            const aliases = t.aliases.split(',').map(a => a.trim());
            const bestAlias = aliases.find(a => text.toLowerCase().includes(a.toLowerCase()));
            if (!bestAlias) continue;

            const score = computeTfIdf(bestAlias, text, totalDocs, docFreqs.get(t.canonical) || 1);
            if (score >= TFIDF_THRESHOLD) {
                insertLink.run(id, t.canonical, bestAlias, Math.round(score * 1000) / 1000);
                entityLinks++;
                linkCount++;
            }
        }
    }

    db.exec('COMMIT');
    db.exec('VACUUM;');
    db.close();

    console.log(`[TERM-REGISTRY] Complete: ${linkCount} term links (threshold: ${TFIDF_THRESHOLD})`);
}

if (process.argv[1]?.endsWith('term-registry-manager.js')) {
    buildTermRegistry().catch(err => {
        console.error('[TERM-REGISTRY] Fatal:', err);
        process.exit(1);
    });
}
