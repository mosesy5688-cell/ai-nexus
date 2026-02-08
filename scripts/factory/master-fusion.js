/**
 * Master Fusion Orchestrator V16.5.0
 * job: Unifies Refined Metadata (Stage 2), HTML Frags (Stage 2), and Mesh Profiles (Stage 4) 
 * into a single atomized "Universal Refined Entity" file.
 */

import fs from 'fs/promises';
import path from 'path';
import { smartWriteWithVersioning } from './lib/smart-writer.js';

const CACHE_DIR = process.env.CACHE_DIR || './cache';
const ENTITIES_DIR = path.join(CACHE_DIR, 'entities');
const HTML_DIR = path.join(CACHE_DIR, 'html');
const MESH_DIR = path.join(CACHE_DIR, 'mesh/profiles');
const FUSED_DIR = path.join(CACHE_DIR, 'fused');

async function getFiles(dir) {
    try {
        const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
        return entries.filter(e => e.isFile() && e.name.endsWith('.json')).map(e => {
            const relPath = path.relative(dir, path.join(e.path, e.name));
            return { name: e.name, relPath, fullPath: path.join(e.path, e.name) };
        });
    } catch { return []; }
}

async function main() {
    console.log('[FUSION] 🧪 Commencing Master Fusion (Stage 4 Final)...');

    // 1. Gather all primary entities (Refined in Stage 2/3)
    const primaryFiles = await getFiles(ENTITIES_DIR);
    console.log(`[FUSION] Identified ${primaryFiles.length} primary entities for fusion.`);

    let fusedCount = 0;

    for (const file of primaryFiles) {
        try {
            const id = file.name.replace('.json', '');

            // Parallel load of all fragments
            const [entityData, htmlData, meshData] = await Promise.all([
                fs.readFile(file.fullPath, 'utf-8').then(JSON.parse).catch(() => null),
                fs.readFile(path.join(HTML_DIR, `${id}.json`), 'utf-8').then(JSON.parse).catch(() => null),
                fs.readFile(path.join(MESH_DIR, `${id}.json`), 'utf-8').then(JSON.parse).catch(() => null)
            ]);

            if (!entityData) continue;

            // 2. Perform Deep Fusion
            const fusedEntity = {
                ...entityData,
                html_readme: htmlData?.html || '',
                mesh_profile: meshData || { relations: [] },
                _fused_at: new Date().toISOString(),
                _version: '16.5.0-master-fusion'
            };

            // 3. Save to ultimate fusion storage
            // Structure: entities/{type}/{id}.json -> fused/{id}.json
            const targetKey = `fused/${id}.json`;
            await smartWriteWithVersioning(targetKey, fusedEntity, CACHE_DIR);

            fusedCount++;
            if (fusedCount % 5000 === 0) console.log(`[FUSION] Fused ${fusedCount} nodes...`);
        } catch (e) {
            console.error(`[FUSION] Skip ${file.name}:`, e.message);
        }
    }

    console.log(`[FUSION] ✅ Finalized ${fusedCount} Universal Refined Entities.`);
}

main().catch(console.error);
