#!/usr/bin/env node
/**
 * V14.3: JSON Sanitizer for L5 Image Processing
 * 
 * Uses streaming approach to parse entities one by one,
 * skipping malformed entries while preserving valid ones.
 * 
 * Usage: node sanitize-json.js input.json output.json
 */

import fs from 'fs';

const inputFile = process.argv[2] || 'data/entities.json';
const outputFile = process.argv[3] || 'data/entities-clean.json';

console.log(`🧹 JSON Sanitizer V14.3.1 (Streaming)`);
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

/**
 * Extract entities by finding JSON object boundaries
 * More robust than line-by-line parsing
 */
function extractEntities(content) {
    const entities = [];
    let failed = 0;

    // Remove outer brackets
    let inner = content.trim();
    if (inner.startsWith('[')) inner = inner.slice(1);
    if (inner.endsWith(']')) inner = inner.slice(0, -1);

    // Track brace depth to find object boundaries
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < inner.length; i++) {
        const char = inner[i];

        if (escaped) {
            escaped = false;
            continue;
        }

        if (char === '\\') {
            escaped = true;
            continue;
        }

        if (char === '"') {
            inString = !inString;
            continue;
        }

        if (inString) continue;

        if (char === '{') {
            if (depth === 0) start = i;
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0 && start !== -1) {
                // Found complete object
                const objStr = inner.slice(start, i + 1);
                try {
                    const obj = JSON.parse(objStr);
                    if (obj && obj.id) {
                        entities.push(obj);
                    }
                } catch (parseErr) {
                    // Try to sanitize and reparse
                    try {
                        const sanitized = sanitizeJsonString(objStr);
                        const obj = JSON.parse(sanitized);
                        if (obj && obj.id) {
                            entities.push(obj);
                        }
                    } catch (e) {
                        failed++;
                    }
                }
                start = -1;
            }
        }
    }

    return { entities, failed };
}

/**
 * Sanitize a JSON string to fix common escape issues
 */
function sanitizeJsonString(str) {
    // Fix incomplete hex escapes (\u followed by less than 4 hex chars)
    str = str.replace(/\\u([0-9a-fA-F]{0,3})(?![0-9a-fA-F])/g, (match, hex) => {
        if (hex.length === 0) return ' ';
        return '\\u' + hex.padStart(4, '0');
    });

    // Fix invalid escape sequences (\ followed by non-escape char)
    str = str.replace(/\\([^"\\\/bfnrtu])/g, '$1');

    // Remove null bytes
    str = str.replace(/\x00/g, '');

    // Remove control characters except \n, \r, \t
    str = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ');

    return str;
}

// Try direct parse first
let entities = [];
let failed = 0;

try {
    // First attempt: direct parse (fastest)
    entities = JSON.parse(rawContent);
    console.log(`✅ Direct parse succeeded: ${entities.length} entities`);
} catch (directErr) {
    console.log(`⚠️ Direct parse failed: ${directErr.message}`);
    console.log(`🔄 Using streaming extraction...`);

    // Second attempt: sanitize entire content then parse
    try {
        const sanitized = sanitizeJsonString(rawContent);
        entities = JSON.parse(sanitized);
        console.log(`✅ Sanitized parse succeeded: ${entities.length} entities`);
    } catch (sanitizedErr) {
        console.log(`⚠️ Sanitized parse failed: ${sanitizedErr.message}`);
        console.log(`🔄 Extracting objects one by one...`);

        // Third attempt: extract objects individually
        const result = extractEntities(rawContent);
        entities = result.entities;
        failed = result.failed;
        console.log(`🔄 Extracted ${entities.length} entities, ${failed} failed`);
    }
}

// Filter entities that have required fields for image processing
const validEntities = entities.filter(e => e && typeof e === 'object' && e.id);
console.log(`✅ ${validEntities.length} entities have valid IDs`);

// Write output
try {
    fs.writeFileSync(outputFile, JSON.stringify(validEntities));
    const stats = fs.statSync(outputFile);
    console.log(`📤 Wrote ${stats.size} bytes to ${outputFile}`);
    console.log(`🎉 Sanitization complete!`);
} catch (writeErr) {
    console.error(`❌ Failed to write output: ${writeErr.message}`);
    process.exit(1);
}
