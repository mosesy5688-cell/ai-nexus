import DB from 'better-sqlite3';
const db = new DB('data/meta-model-core.db');

try {
    const res = db.prepare(`SELECT * FROM search WHERE search MATCH '"llama"*' LIMIT 5`).all();
    console.log("FTS5 Match Results for 'llama':", res.length);
    if (res.length > 0) console.log(res[0]);
} catch (e) {
    console.error("FTS5 Match Error:", e.message);
}

try {
    const res2 = db.prepare(`SELECT COUNT(*) as c FROM entities WHERE name LIKE '%llama%'`).get();
    console.log("LIKE Search Results in entities for 'llama':", res2.c);
} catch (e) {
    console.error("LIKE Search Error:", e.message);
}
