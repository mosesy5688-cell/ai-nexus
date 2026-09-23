// Free2AITools work order N-P4 -- the inherited-FD ledger and its classifier.
//
// P9 was DOUBLE-VACUOUS on run 35758594726: the F3b counterexample kept an
// uncleaned descriptor (fd 9 -> f3b/fd-bait.txt) and the launcher did not go
// red -- phaseD.marker existed. Two independent causes; this module removes
// both, and netns-probe.mjs no longer contains either.
//
// (i) THE INVENTORY MAY NOT COME FROM AN EXTRA exec. The old probe listed
//     /proc/self/fd inside a child it exec'd for the purpose. An exec'd child
//     is handed no inherited non-stdio descriptor, so what it listed was the
//     CHILD's own fd table -- structurally blind to inheritance, which is why
//     fd 9 never appeared in the P9 observation at all. The record read here is
//     the one netns-phases.sh:48-52 writes itself from /proc/$SHELL_PID/fd:
//     that shell IS the process that execs phase D (line 105), and it writes
//     BEFORE that exec. Nothing in this file spawns anything, and no import
//     other than node:fs is permitted here; both are pinned by test, and the
//     banned tokens are pinned as literals, so they appear nowhere above.
//
// (ii) THE ALLOW-LIST JUDGES THE TARGET, NEVER THE NUMBER. The old rule passed
//     0/1/2 by number, so fd 1 -> socket:[19050] and fd 2 -> socket:[19052]
//     were reported with stray: []. Every fd is judged by what it points at
//     here, 0/1/2 included, and the readdir exemption is gone entirely: both
//     real ledgers show bash's glob closed the directory before the loop body,
//     so no readdir handle is ever in the record to exempt.
//
// (iii) THE PARSER MAY NOT SILENTLY DROP A LINE. Recorded lines are counted
//     before parsing; parsed < recorded fails the WHOLE ledger rather than
//     narrowing the list. An absent, unreadable or empty ledger is a FAILURE,
//     never a skip.
import fs from 'node:fs';

/** The only fd numbers that may be open at all at the final identity. */
const STDIO_FDS = Object.freeze(['0', '1', '2']);
/** bash keeps the script it is executing here. It is named, never guessed. */
const SCRIPT_FD = '255';

const isSocket = (t) => t.startsWith('socket:');
const isPipe = (t) => t.startsWith('pipe:');
const isTty = (t) => /^\/dev\/(tty[0-9]*|pts\/\d+|console)$/.test(t);
/**
 * WO-N-P4 B4. A regular file is an absolute path outside the kernel's
 * synthetic trees that names a LEAF. `(deleted)` is refused: an unlinked file
 * still carries whatever it carried. A DIRECTORY is not a regular file --
 * it is the readdir shape (ii) ordered deleted -- so a trailing slash, a "."
 * or ".." tail, and a target that IS a directory on the filesystem this
 * predicate is running on are all refused. The directory probe is ADDITIVE:
 * it can only add a stray, never clear one, so a path this machine cannot
 * resolve is still judged by the shape rule alone. On the runner the targets
 * ARE resolvable -- the self-test runs in the same mount namespace moments
 * after the shell wrote the ledger -- which is where the probe bites.
 */
const isDirectoryNow = (t) => {
    try { return fs.statSync(t).isDirectory(); } catch { return false; }
};
const isRegularFile = (t) => t.startsWith('/') && !t.endsWith('/')
    && !t.includes(' (deleted)') && !/(^|\/)\.\.?$/.test(t)
    && !/^\/(proc|sys|dev)(\/|$)/.test(t) && !isDirectoryNow(t);

/**
 * Returns null when the descriptor is legitimate, or the reason it is stray.
 * Order matters: the socket test runs FIRST and is unconditional, so it also
 * catches a socket sitting on 0, 1, 2 or 255 -- the exact case that passed.
 */
export function strayReason(entry, selfProgram = null) {
    const fd = String(entry.fd);
    const target = String(entry.target);
    if (isSocket(target)) return `socket descriptor (${target})`;
    if (STDIO_FDS.includes(fd)) {
        if (target === '/dev/null' || isPipe(target) || isTty(target)
            || isRegularFile(target)) return null;
        return `stdio fd points at ${target}, not /dev/null, a pipe, a tty or a file`;
    }
    if (fd === SCRIPT_FD) {
        if (selfProgram !== null && target === selfProgram) return null;
        return selfProgram === null
            ? 'fd 255 is open but the caller named no script for it'
            : `fd 255 is ${target}, not the script being executed`;
    }
    return `inherited descriptor (${target})`;
}

/** Every entry the classifier refuses, each carrying WHY it was refused. */
export function strayFds(entries, { selfProgram = null } = {}) {
    const out = [];
    for (const e of entries) {
        const why = strayReason(e, selfProgram);
        if (why !== null) out.push({ fd: String(e.fd), target: String(e.target), why });
    }
    return out;
}

/**
 * The shape netns-phases.sh writes, and ONLY that shape: `<fd>\t<target>\n`.
 * The `ls -l` alternative the old parser also accepted is deliberately gone --
 * no exec produces an inventory any more, so a line in that shape would mean
 * the record came from somewhere this facility does not sanction, and an
 * unrecognised line is a failure rather than a silent omission.
 */
const LEDGER_LINE = /^(\d+)\t([^\t\r]*)$/;

export function parseFdDump(text) {
    const lines = String(text).split('\n');
    // The record's own terminating newline, and nothing else, is discarded.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const entries = [];
    const unparsed = [];
    for (const line of lines) {
        const m = line.match(LEDGER_LINE);
        if (m) entries.push({ fd: m[1], target: m[2] });
        else unparsed.push(line);
    }
    const recorded = lines.length;
    if (recorded === 0) {
        return { ok: false, reason: 'the ledger is empty', recorded, entries, unparsed };
    }
    if (entries.length < recorded) {
        return {
            ok: false,
            reason: `parsed ${entries.length} of ${recorded} recorded lines`,
            recorded, entries, unparsed
        };
    }
    return { ok: true, reason: null, recorded, entries, unparsed };
}

/**
 * Read the pre-exec ledger and classify it. A path that is absent or cannot be
 * read is ok:false -- P9 reads that as FAILURE. The entries and the strays are
 * returned even then: the verdict narrows, the evidence does not.
 */
export function readFdLedger(ledgerPath, { selfProgram = null } = {}) {
    const base = { source: ledgerPath ?? null, recorded: 0, entries: [], stray: [] };
    if (!ledgerPath) return { ...base, ok: false, reason: 'no ledger path was passed' };
    let text = '';
    try {
        text = fs.readFileSync(ledgerPath, 'utf8');
    } catch (e) {
        return { ...base, ok: false, reason: `${ledgerPath} unreadable (${e?.code})` };
    }
    const parsed = parseFdDump(text);
    return {
        ok: parsed.ok, reason: parsed.reason, source: ledgerPath,
        recorded: parsed.recorded, entries: parsed.entries, unparsed: parsed.unparsed,
        stray: strayFds(parsed.entries, { selfProgram })
    };
}
