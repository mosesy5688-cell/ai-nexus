
import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(process.cwd(), 'data', 'meta.db');

try {
    const db = new Database(dbPath, { readonly: true });

    const ids = [
        'paraphrase-multilingual-MiniLM-L12-v2',
        'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
        'speaker-diarization-3.1',
        'pyannote/speaker-diarization-3.1',
        'gpt2',
        'openai-community/gpt2'
    ];

    console.log('Checking specific IDs in entities table:');
    for (const id of ids) {
        const row = db.prepare("SELECT id, name, fni_score FROM entities WHERE id = ? OR name = ?").get(id, id);
        if (row) {
            console.log(`FOUND: ${id} -> fni_score: ${row.fni_score}`);
        } else {
            console.log(`NOT FOUND: ${id}`);
        }
    }

    db.close();
} catch (e) {
    console.error('Error:', e.message);
}
