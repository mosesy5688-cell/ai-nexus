/**
 * V25.9 Parquet Analytical Mirror — V55.9 Secondary Plane
 *
 * Streams entities from PackAccumulator into epoch-tagged Parquet files
 * for BI / ML / RAG analysis. Runs async after .bin generation.
 *
 * Output: output/parquet/entities-{epoch}.parquet + epoch-manifest.json
 * Query: DuckDB, Polars, Spark, pandas — all natively read Parquet.
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

const PARQUET_DIR = './output/parquet';
const DATASETS_DIR = './output/datasets';
const MAX_EPOCHS_RETAINED = 5;
const FNI_VERSION = 'v2.0';

/**
 * Build the Parquet schema for analytical columns.
 * Excludes heavy blobs (readme, body_content) — those stay in .bin shards.
 */
async function getParquetSchema() {
    const parquet = await import('@dsnp/parquetjs');
    return new parquet.ParquetSchema({
        id:              { type: 'UTF8' },
        umid:            { type: 'UTF8' },
        name:            { type: 'UTF8' },
        type:            { type: 'UTF8' },
        author:          { type: 'UTF8' },
        category:        { type: 'UTF8' },
        tags:            { type: 'UTF8' },
        fni_score:       { type: 'FLOAT' },
        fni_s:           { type: 'FLOAT' },
        fni_a:           { type: 'FLOAT' },
        fni_p:           { type: 'FLOAT' },
        fni_r:           { type: 'FLOAT' },
        fni_q:           { type: 'FLOAT' },
        downloads:       { type: 'INT64' },
        stars:           { type: 'INT32' },
        params_billions: { type: 'FLOAT' },
        context_length:  { type: 'INT64' },
        license:         { type: 'UTF8' },
        pipeline_tag:    { type: 'UTF8' },
        source:          { type: 'UTF8' },
        primary_language:{ type: 'UTF8' },
        last_modified:   { type: 'UTF8' },
        is_trending:     { type: 'BOOLEAN' },
    });
}

/**
 * Map a raw entity to Parquet row (analytical columns only).
 */
function entityToRow(e) {
    const str = (v) => {
        if (v == null) return '';
        if (typeof v === 'string') return v;
        if (Array.isArray(v)) return v.join(', ');
        return String(v);
    };
    return {
        id:              str(e.id || e.slug),
        umid:            str(e.umid || e.id),
        name:            str(e.name || e.displayName),
        type:            str(e.type || e.entity_type || 'model'),
        author:          Array.isArray(e.author) ? e.author.join(', ') : str(e.author),
        category:        str(e.category),
        tags:            Array.isArray(e.tags) ? e.tags.join(', ') : str(e.tags),
        fni_score:       Number(e.fni_score ?? e.fni ?? 0),
        fni_s:           Number(e.fni_s ?? 50.0),
        fni_a:           Number(e.fni_a ?? 0),
        fni_p:           Number(e.fni_p ?? 0),
        fni_r:           Number(e.fni_r ?? 0),
        fni_q:           Number(e.fni_q ?? 0),
        downloads:       Number(e.downloads ?? 0),
        stars:           Number(e.stars ?? e.likes ?? 0),
        params_billions: Number(e.params_billions ?? e.params ?? 0),
        context_length:  Number(e.context_length ?? 0),
        license:         str(e.license || e.license_spdx),
        pipeline_tag:    str(e.pipeline_tag || e.task),
        source:          str(e.source || e.source_platform),
        primary_language:str(e.primary_language),
        last_modified:   str(e.last_modified || e.updated_at),
        is_trending:     Boolean(e.is_trending),
    };
}

/**
 * Export all entities from accumulator to epoch-tagged Parquet file.
 * @param {PackAccumulator} accumulator - The SQLite-backed entity store
 * @returns {{ epoch: string, file: string, count: number }}
 */
export async function exportParquet(accumulator) {
    const epoch = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `entities-${epoch}.parquet`;
    const filePath = path.join(PARQUET_DIR, fileName);

    await fs.mkdir(PARQUET_DIR, { recursive: true });

    console.log(`[Parquet] 📊 Exporting Analytical Mirror (epoch: ${epoch})...`);

    const parquet = await import('@dsnp/parquetjs');
    const schema = await getParquetSchema();
    const writer = await parquet.ParquetWriter.openFile(schema, filePath, {
        compression: 'SNAPPY',
        rowGroupSize: 10000,
    });

    let count = 0;
    for (const entity of accumulator.iterate()) {
        await writer.appendRow(entityToRow(entity));
        count++;
        if (count % 100000 === 0) console.log(`[Parquet] Exported ${count} entities...`);
    }

    await writer.close();

    const fileSize = fsSync.statSync(filePath).size;
    console.log(`[Parquet] ✅ ${fileName} — ${count} entities, ${(fileSize / 1024 / 1024).toFixed(2)} MB`);

    // Update epoch manifest for Cross-Epoch Virtual Table Overlays
    await updateEpochManifest(epoch, fileName, count, fileSize);

    return { epoch, file: filePath, count };
}

/**
 * Maintain epoch manifest — tracks all Parquet snapshots for time-consistent queries.
 * Retains only the last MAX_EPOCHS_RETAINED epochs.
 */
async function updateEpochManifest(epoch, fileName, entityCount, fileSize) {
    const manifestPath = path.join(PARQUET_DIR, 'epoch-manifest.json');
    let manifest = { epochs: [] };

    try {
        const raw = await fs.readFile(manifestPath, 'utf-8');
        manifest = JSON.parse(raw);
    } catch { /* first run */ }

    manifest.epochs.push({
        epoch,
        file: fileName,
        entity_count: entityCount,
        size_bytes: fileSize,
        created_at: new Date().toISOString(),
    });

    // Prune old epochs — keep only the latest N
    if (manifest.epochs.length > MAX_EPOCHS_RETAINED) {
        const removed = manifest.epochs.splice(0, manifest.epochs.length - MAX_EPOCHS_RETAINED);
        for (const old of removed) {
            const oldPath = path.join(PARQUET_DIR, old.file);
            await fs.unlink(oldPath).catch(() => {});
        }
    }

    manifest.latest_epoch = epoch;
    manifest.latest_file = fileName;

    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`[Parquet] Epoch manifest updated. Retained: ${manifest.epochs.length}/${MAX_EPOCHS_RETAINED}`);
}

/** Strip Markdown/HTML noise for clean plaintext abstract */
function cleanAbstract(raw) {
    return raw
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')   // [text](url) → text, ![alt](img) → alt
        .replace(/<[^>]+>/g, '')                       // <html tags>
        .replace(/^#{1,6}\s+/gm, '')                   // ### headings
        .replace(/[*_~`]{1,3}/g, '')                   // bold/italic/strike/code markers
        .replace(/\|[^\n]*\|/g, '')                    // table rows
        .replace(/[-=]{3,}/g, '')                      // horizontal rules / heading underlines
        .replace(/\n{2,}/g, '\n')                      // collapse blank lines
        .trim();
}

/**
 * V∞ Phase 4 — Spec §7.1 Lite Tier: Public fni_lite.parquet
 * Fields: id, title, abstract_300, fni_score, fni_version
 * Output: datasets/fni_lite_{date}.parquet + fni_lite_latest.parquet
 */
export async function exportLiteParquet(accumulator) {
    const parquet = await import('@dsnp/parquetjs');
    const schema = new parquet.ParquetSchema({
        id:           { type: 'UTF8' },
        title:        { type: 'UTF8' },
        abstract_300: { type: 'UTF8' },
        fni_score:    { type: 'FLOAT' },
        fni_version:  { type: 'UTF8' },
    });

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '_');
    const fileName = `fni_lite_${date}.parquet`;
    const filePath = path.join(DATASETS_DIR, fileName);
    const latestPath = path.join(DATASETS_DIR, 'fni_lite_latest.parquet');

    await fs.mkdir(DATASETS_DIR, { recursive: true });
    console.log(`[Parquet-Lite] 📊 Exporting Spec §7.1 Lite tier (${date})...`);

    const writer = await parquet.ParquetWriter.openFile(schema, filePath, {
        compression: 'SNAPPY', rowGroupSize: 10000,
    });

    let count = 0;
    for (const e of accumulator.iterate()) {
        const raw = String(e.body_content || e.readme_content || e.description || '');
        await writer.appendRow({
            id:           String(e.id || e.slug || ''),
            title:        String(e.name || e.displayName || ''),
            abstract_300: cleanAbstract(raw).slice(0, 300),
            fni_score:    Number(e.fni_score ?? 0),
            fni_version:  FNI_VERSION,
        });
        count++;
    }
    await writer.close();

    // Copy as _latest (cross-platform, no symlink needed)
    await fs.copyFile(filePath, latestPath);

    const fileSize = fsSync.statSync(filePath).size;
    console.log(`[Parquet-Lite] ✅ ${fileName} — ${count} entities, ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
    return { file: filePath, latest: latestPath, count };
}
