// Free2AITools work order N -- host IPC channels at the final identity.
// Ruling B, the strict option: READ-ONLY. THIS MODULE NEVER CONNECTS TO ANYTHING.
//
// WHAT CHANGED AND WHY. The earlier design probed each classified channel with
// a real connect() and failed the self-test if one answered. That still reached
// a live socket, which is precisely what the ruling rejected: "never touched"
// has to be a CONSTRUCTIVE fact, not an after-the-fact explanation.
//
// So the defence now sits in netns-establish.sh, which MASKS every classified
// channel while still privileged and aborts with 71 if a masking fails -- phase
// C is never reached in that case. What is left here is corroboration:
//   - for each CLASSIFIED path, confirm by stat(2) that it is no longer a
//     socket (masked, or absent to begin with). No connect, no open.
//   - inventory every other socket present. Recorded, never probed, never a
//     pass/fail input.
//
// The channel list is read from classified-channels.tsv. No path or pattern is
// hardcoded here; a test asserts that.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LIST_PATH = path.join(HERE, 'classified-channels.tsv');
const SEARCH_ROOTS = ['/run', '/var/run', '/tmp'];
const MAX_DEPTH = 3;

/** Parse the explicit list. Rows: CLASS, MATCH, TARGET, MASK, RATIONALE. */
export function loadChannelList(file = LIST_PATH) {
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
    const rows = [];
    for (const line of raw.split('\n')) {
        if (!line.trim() || line.startsWith('#')) continue;
        const [cls, match, target, mask, rationale] = line.split('\t');
        if (!cls || !match || !target) continue;
        rows.push({ cls, match, target, mask: mask || 'NONE', rationale: rationale || '' });
    }
    return rows;
}

export const classifiedPaths = (rows) =>
    rows.filter((r) => r.cls === 'CLASSIFIED' && r.match === 'PATH');
export const classifiedPatterns = (rows) =>
    rows.filter((r) => r.cls === 'CLASSIFIED' && r.match === 'PATTERN');

function walk(dir, depth, out) {
    if (depth > MAX_DEPTH) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        const p = `${dir}/${e.name}`;
        try {
            if (e.isSocket()) out.push(p);
            else if (e.isDirectory() && !e.isSymbolicLink()) walk(p, depth + 1, out);
        } catch { /* unreadable entry: omitted, never fatal */ }
    }
}

/** stat(2) only. Returns what the path IS now, without opening it. */
function inspect(p) {
    try {
        const st = fs.lstatSync(p);
        if (st.isSocket()) return 'SOCKET';
        if (st.isCharacterDevice()) return 'CHAR_DEVICE';
        if (st.isDirectory()) return 'DIRECTORY';
        if (st.isFile()) return 'FILE';
        return 'OTHER';
    } catch (e) {
        return e?.code === 'ENOENT' ? 'ABSENT' : `UNREADABLE:${e?.code}`;
    }
}

/**
 * Read-only confirmation plus inventory.
 * ok === false only if a CLASSIFIED path is STILL a socket at the final
 * identity, which would mean the establish-stage masking silently did nothing.
 */
export function inspectChannels() {
    const rows = loadChannelList();
    if (!rows) {
        return {
            ok: false, listLoaded: false, classified: [], recordOnly: [],
            reason: `the explicit channel list could not be read: ${LIST_PATH}`
        };
    }
    const classified = [];
    for (const r of classifiedPaths(rows)) {
        const state = inspect(r.target);
        classified.push({
            path: r.target, mask: r.mask, state,
            // A directory masked with an empty read-only tmpfs still stats as a
            // directory; what matters is that the socket is gone from it.
            residualSockets: state === 'DIRECTORY' ? residual(r.target) : [],
            why: r.rationale
        });
    }
    const patterns = classifiedPatterns(rows)
        .map((r) => ({ re: new RegExp(r.target), why: r.rationale }));
    const found = [];
    for (const root of SEARCH_ROOTS) walk(root, 0, found);
    const recordOnly = [];
    for (const p of [...new Set(found)]) {
        const hit = patterns.find((x) => x.re.test(p));
        if (hit) {
            classified.push({ path: p, mask: 'PATTERN', state: inspect(p), residualSockets: [], why: hit.why });
        } else {
            recordOnly.push({ path: p, state: inspect(p), verdict: 'RECORDED_NEVER_PROBED' });
        }
    }
    const stillOpen = classified.filter(
        (c) => c.state === 'SOCKET' || (c.residualSockets || []).length > 0);
    return {
        ok: stillOpen.length === 0,
        listLoaded: true,
        listPath: LIST_PATH,
        method: 'stat(2) only -- no connect(), no open(), on any channel',
        classified,
        recordOnly,
        stillOpen
    };
}

function residual(dir) {
    const out = [];
    walk(dir, MAX_DEPTH - 1, out);
    return out;
}
