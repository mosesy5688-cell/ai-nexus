import Database from 'better-sqlite3';
const db = new Database('g:/ai-nexus/data/meta.db', { readonly: true });
try {
    const row = db.prepare("SELECT COUNT(*) as count, type FROM entities WHERE type = 'prompt' GROUP BY type").get();
    console.log("Prompt entities in meta.db:", row || 0);

    const total = db.prepare("SELECT COUNT(*) as count, type FROM entities GROUP BY type ORDER BY count DESC").all();
    console.log("All entity counts:");
    console.table(total);
} catch (e) {
    console.error("Error querying meta.db:", e);
} finally {
    db.close();
}
