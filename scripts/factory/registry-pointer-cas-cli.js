/**
 * Thin adapter over putObjectConditional (Founder ruling D-2026-0803-397).
 *
 * Deliberately NO shebang: this file is only ever run as `node <path>` and is
 * imported by a test. Vite's SSR transform emits its preamble above a shebang,
 * which would leave `#!` mid-module and break every suite that imports this.
 *
 * It is NOT a general-purpose writer: the object key is locked to a single
 * authority pointer key and any other key is rejected. The bucket must be
 * supplied explicitly - there is NO production default. The version token
 * arrives through a local JSON version file (structured input) so that shell
 * quoting can never rewrite an opaque ETag.
 *
 * Import is side-effect free: no client is created, no body is read and no
 * network is touched until runPointerCas() is called. No workflow, package
 * script or production module calls this file.
 *
 * Exit codes: 0 = WRITTEN only, 3 = PRECONDITION_FAILED / CONTENTION,
 * 2 = invalid invocation or invalid precondition, 1 = transport/internal fatal.
 */
import fs from 'fs';
import { pathToFileURL } from 'url';
import { putObjectConditional, CAS_WRITE_OUTCOME, CAS_ERROR_CODE, CasError } from './lib/r2-object-cas.js';

export const LOCKED_POINTER_KEY = 'state/_authority/registry/CURRENT.json';

export const POINTER_CAS_EXIT = Object.freeze({
    WRITTEN: 0,
    FATAL: 1,
    INVALID: 2,
    CONTENTION: 3
});

/**
 * D-1 CLOSED OUTPUT VOCABULARY. Every reason this CLI can report is one of these
 * self-authored constants. NOTHING derived from an upstream error (name, Code,
 * code, __type, message) and NOTHING derived from external input (raw argv, the
 * rejected key, any file path, the body) may enter the structured output by any
 * route, because main() prints that payload to stdout. Shape-based filtering of
 * untrusted text is prohibited: a credential can be identifier-shaped.
 */
export const POINTER_CAS_REASON = Object.freeze({
    ACCEPTED: 'ACCEPTED',
    ARG_UNRECOGNIZED: 'ARG_UNRECOGNIZED',
    ARG_BUCKET_REQUIRED: 'ARG_BUCKET_REQUIRED',
    ARG_KEY_REQUIRED: 'ARG_KEY_REQUIRED',
    ARG_KEY_NOT_LOCKED: 'ARG_KEY_NOT_LOCKED',
    ARG_BODY_FILE_REQUIRED: 'ARG_BODY_FILE_REQUIRED',
    ARG_PRECONDITION_SELECTION: 'ARG_PRECONDITION_SELECTION',
    BODY_FILE_UNREADABLE: 'BODY_FILE_UNREADABLE',
    VERSION_FILE_UNREADABLE: 'VERSION_FILE_UNREADABLE',
    VERSION_FILE_MALFORMED: 'VERSION_FILE_MALFORMED',
    VERSION_TOKEN_INVALID: 'VERSION_TOKEN_INVALID',
    VERSION_TOKEN_WILDCARD: 'VERSION_TOKEN_WILDCARD',
    PRECONDITION_REJECTED: 'PRECONDITION_REJECTED',
    CLIENT_UNAVAILABLE: 'CLIENT_UNAVAILABLE',
    CONTENTION: 'CONTENTION',
    TRANSPORT_FATAL: 'TRANSPORT_FATAL'
});

const R = POINTER_CAS_REASON;
const INVALID_CODES = new Set([CAS_ERROR_CODE.INVALID_INVOCATION, CAS_ERROR_CODE.INVALID_PRECONDITION]);

// The reason IS the message: there is no interpolation site to leak through.
class CliInvalid extends Error {
    constructor(reason) { super(reason); this.name = 'CliInvalid'; this.reason = reason; }
}

function parseArgs(argv) {
    const opts = { createIfAbsent: false };
    for (const raw of argv || []) {
        const arg = String(raw);
        if (arg === '--create-if-absent') { opts.createIfAbsent = true; continue; }
        const eq = arg.indexOf('=');
        if (!arg.startsWith('--') || eq < 0) throw new CliInvalid(R.ARG_UNRECOGNIZED);
        const name = arg.slice(2, eq);
        const value = arg.slice(eq + 1);
        if (name === 'bucket') opts.bucket = value;
        else if (name === 'key') opts.key = value;
        else if (name === 'body-file') opts.bodyFile = value;
        else if (name === 'version-file') opts.versionFile = value;
        else throw new CliInvalid(R.ARG_UNRECOGNIZED);
    }
    return opts;
}

function readJsonFile(filePath, readFile) {
    let raw;
    try { raw = readFile(filePath, 'utf8'); } catch (err) { throw new CliInvalid(R.VERSION_FILE_UNREADABLE); }
    try { return JSON.parse(raw); } catch (err) { throw new CliInvalid(R.VERSION_FILE_MALFORMED); }
}

/**
 * Validate the invocation and resolve the exactly-one precondition.
 * Throws CliInvalid for anything that must exit 2 before any network contact.
 */
function resolveRequest(opts, io) {
    if (!opts.bucket) throw new CliInvalid(R.ARG_BUCKET_REQUIRED);
    if (!opts.key) throw new CliInvalid(R.ARG_KEY_REQUIRED);
    if (opts.key !== LOCKED_POINTER_KEY) throw new CliInvalid(R.ARG_KEY_NOT_LOCKED);
    if (!opts.bodyFile) throw new CliInvalid(R.ARG_BODY_FILE_REQUIRED);
    const hasVersionFile = typeof opts.versionFile === 'string' && opts.versionFile.length > 0;
    if (hasVersionFile === opts.createIfAbsent) throw new CliInvalid(R.ARG_PRECONDITION_SELECTION);
    let body;
    try { body = io.readFileBuffer(opts.bodyFile); } catch (err) { throw new CliInvalid(R.BODY_FILE_UNREADABLE); }
    const request = { bucket: opts.bucket, key: opts.key, body, contentType: 'application/json' };
    if (opts.createIfAbsent) {
        request.ifNoneMatch = '*';
        return request;
    }
    const parsed = readJsonFile(opts.versionFile, io.readFileText);
    const version = parsed && parsed.version;
    if (typeof version !== 'string' || version.length === 0) throw new CliInvalid(R.VERSION_TOKEN_INVALID);
    // '*' would make this an existence check instead of a compare-and-swap, silently
    // overwriting whichever version happens to be current. Rejected at this layer too.
    if (version === '*') throw new CliInvalid(R.VERSION_TOKEN_WILDCARD);
    // The token is forwarded verbatim: never unquoted, trimmed or regenerated.
    request.ifMatch = version;
    return request;
}

async function defaultCreateClient() {
    const helpers = await import('./lib/r2-helpers.js');
    return helpers.createR2Client();
}

// Only closed constants reach the payload: exit_code, status, reason and the
// locked-key summary. No error_name, no error_class, no free-form detail.
const report = (exit_code, status, reason, extra) => ({ exit_code, status, reason, ...extra });

// A thrown CasError maps to one of OUR reasons by its OWN code, never by any
// upstream string. Anything unrecognised collapses to TRANSPORT_FATAL.
const reasonForCas = (code) => (INVALID_CODES.has(code) ? R.PRECONDITION_REJECTED : R.TRANSPORT_FATAL);

/**
 * Structured, body-free and credential-free result. Returns
 * { exit_code, status, reason, ... } and never prints or exits by itself.
 */
export async function runPointerCas(argv, deps) {
    const d = deps || {};
    const io = {
        readFileBuffer: d.readFileBuffer || ((p) => fs.readFileSync(p)),
        readFileText: d.readFileText || ((p, enc) => fs.readFileSync(p, enc))
    };
    let request;
    try {
        request = resolveRequest(parseArgs(argv), io);
    } catch (err) {
        const reason = err instanceof CliInvalid && R[err.reason] ? err.reason : R.ARG_UNRECOGNIZED;
        return report(POINTER_CAS_EXIT.INVALID, 'INVALID_INVOCATION', reason);
    }
    // Every field here is self-authored or a byte count; key is the locked constant.
    const summary = {
        key: LOCKED_POINTER_KEY,
        condition: request.ifMatch ? 'IfMatch' : 'IfNoneMatch',
        create_if_absent: request.ifNoneMatch === '*',
        body_bytes: request.body ? request.body.length : 0
    };
    let client;
    try {
        client = await (d.createClient || defaultCreateClient)();
    } catch (err) {
        // A client-construction fault can embed a credential, so nothing from it is kept.
        return report(POINTER_CAS_EXIT.FATAL, 'CLIENT_UNAVAILABLE', R.CLIENT_UNAVAILABLE, summary);
    }
    if (!client) return report(POINTER_CAS_EXIT.FATAL, 'CLIENT_UNAVAILABLE', R.CLIENT_UNAVAILABLE, summary);
    let result;
    try {
        result = await putObjectConditional(client, request);
    } catch (err) {
        const code = err instanceof CasError ? err.code : null;
        const exit = INVALID_CODES.has(code) ? POINTER_CAS_EXIT.INVALID : POINTER_CAS_EXIT.FATAL;
        const status = exit === POINTER_CAS_EXIT.INVALID ? 'INVALID_PRECONDITION' : 'FATAL';
        return report(exit, status, reasonForCas(code), summary);
    }
    // Exit 0 is reserved for a server-accepted conditional write by THIS writer.
    if (result.outcome === CAS_WRITE_OUTCOME.WRITTEN) {
        return report(POINTER_CAS_EXIT.WRITTEN, CAS_WRITE_OUTCOME.WRITTEN, R.ACCEPTED,
            { ...summary, outcome: result.outcome, new_version: result.version });
    }
    return report(POINTER_CAS_EXIT.CONTENTION, result.outcome, R.CONTENTION,
        { ...summary, outcome: result.outcome, http_status: result.http_status });
}

export async function main(argv) {
    const result = await runPointerCas(argv);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.exit_code;
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entry && entry === import.meta.url) {
    main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
