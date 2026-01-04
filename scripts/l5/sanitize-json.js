#!/usr/bin/env node
/**
 * V14.3: JSON Sanitizer for L5 Image Processing
 * 
 * Reads entities.json with Node.js (more forgiving parser),
 * validates each entity, skips malformed ones, and outputs
 * clean JSON for Rust image optimizer.
 * 
 * Usage: node sanitize-json.js input.json output.json
 */

const fs = require('fs');
const path = require('path');

const inputFile = process.argv[2] || 'data/entities.json';
const outputFile = process.argv[3] || 'data/entities-clean.json';

console.log(`🧹 JSON Sanitizer V14.3`);
console.log(`📥 Input: ${inputFile}`);
console.log(`📤 Output: ${outputFile}`);

// Read raw file content
let rawContent;
try {
    rawContent = fs.readFileSync(inputFile, 'utf8');
    console.log(`📄 Read ${rawContent.length} bytes`);
} catch (err) {
    console.error(`❌ Failed to read input file: ${err.message}`);
    process.exit(1);
}

// Fix common JSON escape issues before parsing
function sanitizeJsonString(str) {
    // Fix incomplete hex escapes like \u00 without 4 digits
    str = str.replace(/\\u([0-9a-fA-F]{0,3})(?![0-9a-fA-F])/g, (match, hex) => {
        // Pad to 4 digits or replace with space
        if (hex.length === 0) return ' ';
        return '\\u' + hex.padStart(4, '0');
    });

    // Fix invalid escape sequences
    str = str.replace(/\\([^"\\\/bfnrtu])/g, '$1');

    // Remove null bytes
    str = str.replace(/\x00/g, '');

    return str;
}

// Sanitize the raw content
const sanitizedContent = sanitizeJsonString(rawContent);

// Parse JSON
let entities;
try {
    entities = JSON.parse(sanitizedContent);
    console.log(`✅ Parsed ${entities.length} entities`);
} catch (parseErr) {
    console.error(`❌ JSON parse failed after sanitization: ${parseErr.message}`);

    // Try line-by-line fallback for JSON Lines format
    console.log(`🔄 Attempting line-by-line recovery...`);
    entities = [];
    const lines = sanitizedContent.split('\n');
    let recovered = 0;
    let failed = 0;

    for (const line of lines) {
        if (!line.trim() || line.trim() === '[' || line.trim() === ']') continue;
        try {
            // Remove trailing comma for JSON array format
            const cleanLine = line.replace(/,\s*$/, '');
            if (cleanLine.trim()) {
                const entity = JSON.parse(cleanLine);
                entities.push(entity);
                recovered++;
            }
        } catch (lineErr) {
            failed++;
        }
    }

    if (entities.length === 0) {
        console.error(`❌ Could not recover any entities`);
        process.exit(1);
    }

    console.log(`🔄 Recovered ${recovered} entities, ${failed} failed`);
}

// Validate and clean each entity
const cleanEntities = [];
let skipped = 0;

for (const entity of entities) {
    try {
        // Validate required field
        if (!entity.id) {
            skipped++;
            continue;
        }

        // Clean string fields
        const cleanEntity = {};
        for (const [key, value] of Object.entries(entity)) {
            if (typeof value === 'string') {
                // Remove control characters except newline/tab
                cleanEntity[key] = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ');
            } else {
                cleanEntity[key] = value;
            }
        }

        // Verify it serializes cleanly
        JSON.stringify(cleanEntity);
        cleanEntities.push(cleanEntity);
    } catch (entityErr) {
        skipped++;
    }
}

console.log(`✅ Validated ${cleanEntities.length} entities (${skipped} skipped)`);

// Write clean JSON
try {
    fs.writeFileSync(outputFile, JSON.stringify(cleanEntities));
    const stats = fs.statSync(outputFile);
    console.log(`📤 Wrote ${stats.size} bytes to ${outputFile}`);
    console.log(`🎉 Sanitization complete!`);
} catch (writeErr) {
    console.error(`❌ Failed to write output: ${writeErr.message}`);
    process.exit(1);
}
