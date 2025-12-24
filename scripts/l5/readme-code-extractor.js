/**
 * L5 README Code Extractor V1.0
 * Phase B.8: User Understanding Infrastructure
 * 
 * Extracts code examples from README body_content for display
 * 
 * Fallback priority:
 * 1. ```python ... ```
 * 2. ```bash ... ```
 * 3. ```javascript ... ```
 * 4. null (hide component)
 * 
 * Usage:
 *   node scripts/l5/readme-code-extractor.js data/entities.json data/enriched.json
 */

import fs from 'fs';

// Code block patterns with priority
const CODE_PATTERNS = [
    { lang: 'python', pattern: /```python\s*([\s\S]*?)```/i },
    { lang: 'bash', pattern: /```bash\s*([\s\S]*?)```/i },
    { lang: 'shell', pattern: /```shell\s*([\s\S]*?)```/i },
    { lang: 'javascript', pattern: /```javascript\s*([\s\S]*?)```/i },
    { lang: 'js', pattern: /```js\s*([\s\S]*?)```/i },
    { lang: 'code', pattern: /```\s*([\s\S]*?)```/ } // Generic fallback
];

/**
 * Extract first usable code block from README
 */
function extractCodeExample(readme) {
    if (!readme || typeof readme !== 'string') return null;

    for (const { lang, pattern } of CODE_PATTERNS) {
        const match = readme.match(pattern);
        if (match && match[1]) {
            const code = match[1].trim();
            // Skip very short snippets (likely not useful)
            if (code.length < 20) continue;
            // Skip if it's just a pip install
            if (code.startsWith('pip install') && code.split('\n').length < 3) continue;

            return {
                language: lang === 'shell' ? 'bash' : lang,
                code: code.substring(0, 2000), // Limit size
                lines: code.split('\n').length
            };
        }
    }

    return null;
}

/**
 * Process entities and extract code examples
 */
function extractCodeFromEntities(entities) {
    let extracted = 0;
    let skipped = 0;

    for (const entity of entities) {
        const readme = entity.body_content || entity.description || '';
        const codeExample = extractCodeExample(readme);

        if (codeExample) {
            // Initialize meta structure
            if (!entity.meta_json) entity.meta_json = {};
            if (typeof entity.meta_json === 'string') {
                try {
                    entity.meta_json = JSON.parse(entity.meta_json);
                } catch { entity.meta_json = {}; }
            }

            if (!entity.meta_json.extended) entity.meta_json.extended = {};

            // Store code example
            entity.meta_json.extended.example_code = codeExample.code;
            entity.meta_json.extended.example_lang = codeExample.language;

            extracted++;
        } else {
            skipped++;
        }
    }

    console.log(`📝 Code Extraction: ${extracted} extracted, ${skipped} skipped`);
    return entities;
}

/**
 * Main execution
 */
async function main() {
    const args = process.argv.slice(2);
    const inputPath = args[0] || 'data/entities.json';
    const outputPath = args[1] || 'data/entities_with_code.json';

    console.log('📝 L5 README Code Extractor V1.0');
    console.log(`📄 Input: ${inputPath}`);
    console.log(`📄 Output: ${outputPath}`);

    // Load entities
    if (!fs.existsSync(inputPath)) {
        console.error('❌ Input file not found:', inputPath);
        process.exit(1);
    }

    const entities = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    console.log(`📊 Loaded ${entities.length} entities`);

    // Extract code
    const enrichedEntities = extractCodeFromEntities(entities);

    // Write output
    fs.writeFileSync(outputPath, JSON.stringify(enrichedEntities, null, 2));
    console.log(`✅ Written to: ${outputPath}`);

    // Summary
    const withCode = enrichedEntities.filter(e =>
        e.meta_json?.extended?.example_code
    ).length;

    console.log(`📊 Summary: ${withCode}/${enrichedEntities.length} entities have code examples`);
}

main().catch(err => {
    console.error('❌ Code extraction failed:', err);
    process.exit(1);
});
