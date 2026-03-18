import fs from 'fs';
import path from 'path';

function walk(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat && stat.isDirectory()) {
            results = results.concat(walk(fullPath));
        } else {
            results.push(fullPath);
        }
    });
    return results;
}

const srcDir = './src';
const files = walk(srcDir);

console.log(`R2 MIGRATION: Scanning ${files.length} files...`);

files.forEach(file => {
    if (!file.endsWith('.astro') && !file.endsWith('.ts') && !file.endsWith('.js')) return;

    try {
        let content = fs.readFileSync(file, 'utf8');
        if (content.includes('R2_ASSETS')) {
            const newContent = content.replace(/R2_ASSETS/g, 'R2_ASSETS');
            fs.writeFileSync(file, newContent, 'utf8');
            console.log(`Migrated: ${file}`);
        }
    } catch (err) {
        // console.error(`Error migrating ${file}:`, err.message);
    }
});

console.log('R2 MIGRATION COMPLETE.');
