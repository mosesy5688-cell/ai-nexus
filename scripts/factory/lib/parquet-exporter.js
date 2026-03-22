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
const MAX_EPOCHS_RETAINED = 5;

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
        fni_p:           { type: 'FLOAT' },
        fni_f:           { type: 'FLOAT' },
        fni_c:           { type: 'FLOAT' },
        fni_u:           { type: 'FLOAT' },
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
        fni_p:           Number(e.fni_p ?? 0),
        fni_f:           Number(e.fni_f ?? 0),
        fni_c:           Number(e.fni_c ?? 0),
        fni_u:           Number(e.fni_u ?? 0),
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
