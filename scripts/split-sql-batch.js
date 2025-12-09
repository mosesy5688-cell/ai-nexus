#!/usr/bin/env node
/**
 * SQL Batch Splitter
 * 
 * Splits large SQL files into smaller batches for D1 upload.
 * D1 has internal limits, using 500KB batches for reliability.
 * 
 * Usage: node scripts/split-sql-batch.js <input.sql> <output-dir>
 * 
 * @module scripts/split-sql-batch
 */

import fs from 'fs';
import path from 'path';

// 500KB per batch for D1 compatibility (D1 has internal transaction limits)
const MAX_BATCH_SIZE = 500 * 1024;

/**
 * Split SQL content into individual statements, respecting quoted strings
 * This prevents splitting inside string literals that contain semicolons
 */
function splitSqlStatements(content) {
    const statements = [];
    let currentStatement = '';
    let inSingleQuote = false;
    let escapeNext = false;

    for (let i = 0; i < content.length; i++) {
        const char = content[i];

        if (escapeNext) {
            currentStatement += char;
            escapeNext = false;
            continue;
        }

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
                statements.push(trimmed);
            }
            currentStatement = '';
        } else {
            currentStatement += char;
        }
    }

    // Add final statement if exists
    const trimmed = currentStatement.trim();
    if (trimmed.length > 0) {
        statements.push(trimmed);
    }

    return statements;
}

function splitSqlFile(inputFile, outputDir) {
    console.log(`📦 Splitting ${inputFile} into batches...`);

    if (!fs.existsSync(inputFile)) {
        console.error(`❌ Input file not found: ${inputFile}`);
        process.exit(1);
    }

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const content = fs.readFileSync(inputFile, 'utf8');

    // Smart SQL splitting that respects quoted strings
    const statements = splitSqlStatements(content);

    console.log(`   Total statements: ${statements.length}`);

    let currentBatch = '';
    let batchNumber = 1;
    let statementsInBatch = 0;
    const batches = [];

    for (const statement of statements) {
        const stmtWithSemicolon = statement.trim() + ';\n';

        // Check if adding this statement would exceed batch size
        if (currentBatch.length + stmtWithSemicolon.length > MAX_BATCH_SIZE && currentBatch.length > 0) {
            // Save current batch
            const batchFile = path.join(outputDir, `batch_${String(batchNumber).padStart(3, '0')}.sql`);
            fs.writeFileSync(batchFile, currentBatch);
            batches.push({ file: batchFile, statements: statementsInBatch, size: currentBatch.length });
            console.log(`   Batch ${batchNumber}: ${statementsInBatch} statements, ${(currentBatch.length / 1024).toFixed(1)}KB`);

            // Start new batch
            currentBatch = '';
            statementsInBatch = 0;
            batchNumber++;
        }

        currentBatch += stmtWithSemicolon;
        statementsInBatch++;
    }

    // Save final batch
    if (currentBatch.length > 0) {
        const batchFile = path.join(outputDir, `batch_${String(batchNumber).padStart(3, '0')}.sql`);
        fs.writeFileSync(batchFile, currentBatch);
        batches.push({ file: batchFile, statements: statementsInBatch, size: currentBatch.length });
        console.log(`   Batch ${batchNumber}: ${statementsInBatch} statements, ${(currentBatch.length / 1024).toFixed(1)}KB`);
    }

    console.log(`✅ Created ${batches.length} batch files in ${outputDir}`);

    // Write manifest for workflow
    const manifest = {
        totalBatches: batches.length,
        totalStatements: statements.length,
        batches: batches.map(b => ({ file: path.basename(b.file), statements: b.statements, sizeBytes: b.size }))
    };
    fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    return batches.length;
}

// Main execution
const args = process.argv.slice(2);
if (args.length < 2) {
    console.log('Usage: node scripts/split-sql-batch.js <input.sql> <output-dir>');
    process.exit(1);
}

splitSqlFile(args[0], args[1]);
