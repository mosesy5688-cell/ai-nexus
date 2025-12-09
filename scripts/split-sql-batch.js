#!/usr/bin/env node
/**
 * SQL Transactional Batch Splitter
 * 
 * Splits large SQL files into transaction-wrapped micro-batches for D1 upload.
 * Optimized for FTS5 indexed tables with conservative limits.
 * 
 * Key optimizations per Architect review:
 * - Transaction wrapping: BEGIN TRANSACTION; ... COMMIT; for 10x speed + atomicity
 * - Conservative row limits: 50 rows/batch (safe for FTS5 CPU overhead)
 * - Byte limits: 100KB/batch (safe for D1 memory)
 * 
 * Usage: node scripts/split-sql-batch.js <input.sql> [output-dir]
 * 
 * @module scripts/split-sql-batch
 */

import fs from 'fs';
import path from 'path';

// ============================================================
// Configuration - Architect Recommended Settings
// ============================================================
const MAX_BATCH_SIZE = 100 * 1024;  // 100 KB (strict limit)
const MAX_ROWS_PER_BATCH = 50;       // 50 rows (conservative for FTS5)

/**
 * Split SQL content into individual statements, respecting quoted strings
 * This prevents splitting inside string literals that contain semicolons
 */
function splitSqlStatements(content) {
    const statements = [];
    let currentStatement = '';
    let inSingleQuote = false;

    for (let i = 0; i < content.length; i++) {
        const char = content[i];

        // Handle escape sequences ('' in SQL)
        if (char === "'" && content[i + 1] === "'") {
            currentStatement += "''";
            i++; // Skip next quote
            continue;
        }

        // Toggle quote state
        if (char === "'") {
            inSingleQuote = !inSingleQuote;
        }

        // Check for statement end (semicolon outside quotes)
        if (char === ';' && !inSingleQuote) {
            const trimmed = currentStatement.trim();
            if (trimmed.length > 0) {
                statements.push(trimmed + ';');
            }
            currentStatement = '';
        } else {
            currentStatement += char;
        }
    }

    // Add final statement if exists
    const trimmed = currentStatement.trim();
    if (trimmed.length > 0 && !trimmed.startsWith('--')) {
        statements.push(trimmed.endsWith(';') ? trimmed : trimmed + ';');
    }

    return statements;
}

/**
 * Split SQL file into transaction-wrapped micro-batches
 */
function splitSqlFile(inputFile, outputDir) {
    console.log(`📦 Splitting ${inputFile} into transactional batches...`);
    console.log(`   Config: ${MAX_ROWS_PER_BATCH} rows/batch, ${MAX_BATCH_SIZE / 1024}KB max`);

    if (!fs.existsSync(inputFile)) {
        console.error(`❌ Input file not found: ${inputFile}`);
        process.exit(1);
    }

    // Clean and recreate output directory
    if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true });
    }
    fs.mkdirSync(outputDir, { recursive: true });

    const content = fs.readFileSync(inputFile, 'utf8');

    // Smart SQL splitting that respects quoted strings
    const statements = splitSqlStatements(content);

    if (statements.length === 0) {
        console.log('   No statements to batch.');
        // Create empty manifest
        fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify({
            totalBatches: 0,
            totalStatements: 0,
            batches: []
        }, null, 2));
        return 0;
    }

    console.log(`   Total statements: ${statements.length}`);

    let batchNumber = 1;
    let currentBatch = [];
    let currentSize = 0;
    const batches = [];

    function writeBatch() {
        if (currentBatch.length === 0) return;

        // ✨ MAGIC SAUCE: Wrap in Transaction ✨
        // This provides: 1) Atomicity 2) 10x speed boost 3) Reduced disk I/O
        const batchContent = [
            'BEGIN TRANSACTION;',
            ...currentBatch,
            'COMMIT;'
        ].join('\n');

        const fileName = `batch_${String(batchNumber).padStart(3, '0')}.sql`;
        const filePath = path.join(outputDir, fileName);
        fs.writeFileSync(filePath, batchContent);

        const sizeKB = (batchContent.length / 1024).toFixed(2);
        console.log(`   ${fileName}: ${currentBatch.length} rows, ${sizeKB} KB`);

        batches.push({
            file: fileName,
            statements: currentBatch.length,
            sizeBytes: batchContent.length
        });

        batchNumber++;
        currentBatch = [];
        currentSize = 0;
    }

    for (const stmt of statements) {
        const stmtSize = Buffer.byteLength(stmt, 'utf8');

        // Check both limits: row count AND byte size
        if (currentBatch.length >= MAX_ROWS_PER_BATCH ||
            (currentSize + stmtSize) > MAX_BATCH_SIZE) {
            writeBatch();
        }

        currentBatch.push(stmt);
        currentSize += stmtSize;
    }

    // Write remaining batch
    writeBatch();

    // Write manifest for workflow
    const manifest = {
        totalBatches: batches.length,
        totalStatements: statements.length,
        config: {
            maxRowsPerBatch: MAX_ROWS_PER_BATCH,
            maxBatchSizeBytes: MAX_BATCH_SIZE
        },
        batches: batches
    };
    fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    console.log(`✅ Created ${batches.length} transaction-wrapped batches in ${outputDir}`);
    return batches.length;
}

// ============================================================
// Main Execution
// ============================================================
const args = process.argv.slice(2);
if (args.length < 1) {
    console.log('Usage: node scripts/split-sql-batch.js <input.sql> [output-dir]');
    console.log('Example: node scripts/split-sql-batch.js data/upsert.sql data/upsert_batches');
    process.exit(1);
}

const inputFile = args[0];
const outputDir = args[1] || inputFile.replace('.sql', '_batches');

splitSqlFile(inputFile, outputDir);
