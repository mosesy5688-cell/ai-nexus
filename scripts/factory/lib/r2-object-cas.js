/**
 * R2 compare-and-swap object primitive (Founder ruling D-2026-0803-397).
 *
 * Tiny and inert: ONE single-response read carrying its own opaque version token,
 * ONE single-part conditional write, ONE pure state classifier. No retry loop, no
 * generation allocation, no pointer schema, no publication orchestration. NO R2
 * runtime exercise has been performed; nothing here is wired to production.
 * HeadObjectCommand is intentionally NOT imported: a HEAD + GET split read can
 * return a version token that does not belong to the body that was read.
 */
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

export const CAS_READ_STATE = Object.freeze({ PRESENT: 'PRESENT', ABSENT: 'ABSENT' });

export const CAS_WRITE_OUTCOME = Object.freeze({
    WRITTEN: 'WRITTEN', PRECONDITION_FAILED: 'PRECONDITION_FAILED', CONTENTION: 'CONTENTION'
});

export const CAS_CLASSIFICATION = Object.freeze({
    INTENDED_GENERATION_NOT_NEW: 'INTENDED_GENERATION_NOT_NEW', SUPERSEDED: 'SUPERSEDED',
    SUPERSEDED_BY_EQUIVALENT: 'SUPERSEDED_BY_EQUIVALENT',
    FORK_AUTHORITY_COLLISION: 'FORK_AUTHORITY_COLLISION',
    GENERATION_REGRESSION_FORK: 'GENERATION_REGRESSION_FORK',
    CONTENTION_WITHOUT_OBSERVED_ADVANCE: 'CONTENTION_WITHOUT_OBSERVED_ADVANCE',
    CONTENTION_REREAD_INVALID: 'CONTENTION_REREAD_INVALID', RETRY_ELIGIBLE: 'RETRY_ELIGIBLE'
});

export const CAS_ERROR_CODE = Object.freeze({
    INVALID_INVOCATION: 'CAS_INVALID_INVOCATION', INVALID_PRECONDITION: 'CAS_INVALID_PRECONDITION',
    INVALID_CLASSIFIER_INPUT: 'CAS_INVALID_CLASSIFIER_INPUT', READ_FAILED: 'CAS_READ_FAILED',
    VERSION_MISSING: 'CAS_VERSION_MISSING', BODY_READ_FAILED: 'CAS_BODY_READ_FAILED',
    TRUNCATED_BODY: 'CAS_TRUNCATED_BODY', PUT_FAILED: 'CAS_PUT_FAILED',
    INVALID_RESPONSE: 'CAS_INVALID_RESPONSE'
});

export class CasError extends Error {
    constructor(code, message, cause) { super(message); this.name = 'CasError'; this.code = code; this.cause = cause; }
}

const errorStatus = (e) => (e && e.$metadata && typeof e.$metadata.httpStatusCode === 'number' ? e.$metadata.httpStatusCode : null);

// Every service-code shape the SDK and hand-rolled errors use. The generic 'Error'
// name is dropped so a plain Error carrying Code:'PreconditionFailed' still classifies.
function errorCodes(err) {
    if (!err) return [];
    const out = [];
    for (const v of [err.name, err.Code, err.code, err.__type]) {
        if (typeof v === 'string' && v.length > 0 && v !== 'Error' && !out.includes(v)) out.push(v);
    }
    return out;
}

const hasCode = (err, ...names) => names.some((n) => errorCodes(err).includes(n));

/**
 * STATUS PRECEDENCE (locked clauses A and B), one rule for BOTH paths: a numeric
 * HTTP status, when present, decides ALONE and a service code can NEVER override
 * it; only a status-less error consults codes. Read: 404 is ABSENT, so 403, 409,
 * 412 and every 5xx fail loud even when named NoSuchKey; status-less, ABSENT iff a
 * code is exactly 'NoSuchKey' (NoSuchBucket unchanged: ABSENT only via a real 404).
 * Write: 412 PRECONDITION_FAILED, 409 CONTENTION, every other status fatal;
 * status-less, only the exact codes below decide and anything else is fatal.
 */
const isAbsentError = (err) => (errorStatus(err) !== null
    ? errorStatus(err) === 404 : hasCode(err, 'NoSuchKey'));

const contentionForStatus = (s) => (s === 412 ? CAS_WRITE_OUTCOME.PRECONDITION_FAILED
    : s === 409 ? CAS_WRITE_OUTCOME.CONTENTION : null);

const contentionForCode = (err) => (hasCode(err, 'PreconditionFailed') ? CAS_WRITE_OUTCOME.PRECONDITION_FAILED
    : hasCode(err, 'ConflictException', 'OperationAborted') ? CAS_WRITE_OUTCOME.CONTENTION : null);

function requireField(value, label) {
    if (typeof value === 'string' && value.length > 0) return value;
    throw new CasError(CAS_ERROR_CODE.INVALID_INVOCATION, `${label} is required`);
}

const requireTarget = (p) => ({
    bucket: requireField((p || {}).bucket, 'bucket'), key: requireField((p || {}).key, 'key')
});

async function drainBody(body) {
    if (body === null || body === undefined) throw new Error('response body is missing');
    if (typeof body.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray());
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof Uint8Array) return Buffer.from(body);
    if (typeof body[Symbol.asyncIterator] === 'function') {
        const chunks = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        return Buffer.concat(chunks);
    }
    throw new Error('response body is not readable');
}

// Usable declared length, else NaN. NaN never equals body.length, so an absent /
// null / unusable ContentLength FAILS the guard instead of silently disabling it.
// Number, BigInt and digit-string are accepted; 0 is a legitimate declared length.
function declaredLength(value) {
    if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : NaN;
    if (typeof value === 'bigint') return value >= 0n ? Number(value) : NaN;
    if (typeof value === 'string' && /^[0-9]+$/.test(value)) return Number(value);
    return NaN;
}

/**
 * Single-response read: body AND the exact server ETag from ONE GetObjectCommand.
 * The ETag is opaque, returned verbatim. The ContentLength of that SAME response is
 * enforced, so a truncated body never surfaces as a PRESENT (version, body) pair.
 */
export async function readObjectWithVersion(client, params) {
    const { bucket, key } = requireTarget(params);
    let response;
    try {
        response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    } catch (err) {
        if (isAbsentError(err)) return { state: CAS_READ_STATE.ABSENT, version: null, body: null, content_length: 0 };
        throw new CasError(CAS_ERROR_CODE.READ_FAILED, `read failed for ${key}`, err);
    }
    const version = response ? response.ETag : undefined;
    if (typeof version !== 'string' || version.length === 0) {
        throw new CasError(CAS_ERROR_CODE.VERSION_MISSING, `no version token returned for ${key}`);
    }
    let body;
    // A body-read fault is a loud failure. It must never masquerade as absence.
    try { body = await drainBody(response.Body); } catch (err) {
        throw new CasError(CAS_ERROR_CODE.BODY_READ_FAILED, `body read failed for ${key}`, err);
    }
    if (declaredLength(response.ContentLength) !== body.length) {
        throw new CasError(CAS_ERROR_CODE.TRUNCATED_BODY,
            `body for ${key} is ${body.length} bytes against an unusable or mismatched declared length`);
    }
    return { state: CAS_READ_STATE.PRESENT, version, body, content_length: body.length };
}

const buildConditionInput = (ifMatch, ifNoneMatch, useIfMatch) => (useIfMatch ? { IfMatch: ifMatch } : { IfNoneMatch: ifNoneMatch });

const writeResult = (outcome, status, version) => ({
    outcome, contention: outcome !== CAS_WRITE_OUTCOME.WRITTEN,
    http_status: status === undefined ? null : status, version: version === undefined ? null : version
});

/**
 * E-2 ACCEPTANCE RULE (locked clause B). WRITTEN is never inferred from "send did
 * not throw". Not an object -> invalid. WRITTEN ALWAYS requires a usable ETag, so a
 * 2xx without one is invalid rather than a token-less success, and 206 partial
 * content is never WRITTEN. 412 / 409 are the contention pair; every other status
 * is invalid. Returning null makes the caller throw CAS_INVALID_RESPONSE.
 */
function classifyPutResponse(response) {
    if (!response || typeof response !== 'object') return null;
    const status = errorStatus(response);
    const etag = typeof response.ETag === 'string' && response.ETag.length > 0 ? response.ETag : null;
    if (status === null) return etag ? writeResult(CAS_WRITE_OUTCOME.WRITTEN, null, etag) : null;
    if (status >= 200 && status <= 299) {
        return etag && status !== 206 ? writeResult(CAS_WRITE_OUTCOME.WRITTEN, status, etag) : null;
    }
    const contention = contentionForStatus(status);
    return contention ? writeResult(contention, status) : null;
}

/**
 * Single-part conditional write carrying exactly one of IfMatch or IfNoneMatch. No
 * multipart, no Upload helper, no unconditional fallback, no internal retry. 412
 * and 409 are distinct terminal contention outcomes; every other fault throws.
 */
export async function putObjectConditional(client, params) {
    const { bucket, key } = requireTarget(params);
    const body = params.body;
    if (body === null || body === undefined) throw new CasError(CAS_ERROR_CODE.INVALID_INVOCATION, 'body is required');
    // Presence, not usability, decides "supplied", so a junk ifMatch alongside a
    // valid ifNoneMatch is a double condition rather than a silent cold-start create.
    const useIfMatch = params.ifMatch !== undefined && params.ifMatch !== null;
    const useIfNoneMatch = params.ifNoneMatch !== undefined && params.ifNoneMatch !== null;
    if (useIfMatch === useIfNoneMatch) {
        throw new CasError(CAS_ERROR_CODE.INVALID_PRECONDITION,
            'exactly one of ifMatch or ifNoneMatch must be supplied');
    }
    // '*' as IfMatch is an existence check, not a compare-and-swap: it would let any
    // current version satisfy the precondition and silently lose another writer's update.
    if (useIfMatch && (typeof params.ifMatch !== 'string' || params.ifMatch.length === 0
        || params.ifMatch === '*')) {
        throw new CasError(CAS_ERROR_CODE.INVALID_PRECONDITION,
            "ifMatch must be a non-empty opaque version token and must not be '*'");
    }
    if (useIfNoneMatch && params.ifNoneMatch !== '*') {
        throw new CasError(CAS_ERROR_CODE.INVALID_PRECONDITION, "ifNoneMatch must be '*'");
    }
    const conditions = buildConditionInput(params.ifMatch, params.ifNoneMatch, useIfMatch);
    const input = { Bucket: bucket, Key: key, Body: body, ...conditions };
    if (typeof params.contentType === 'string' && params.contentType.length > 0) input.ContentType = params.contentType;
    let response;
    try {
        response = await client.send(new PutObjectCommand(input));
    } catch (err) {
        const status = errorStatus(err);
        // Status decides alone when present; only a status-less error consults codes.
        const contention = status !== null ? contentionForStatus(status) : contentionForCode(err);
        if (contention) return writeResult(contention, status);
        throw new CasError(CAS_ERROR_CODE.PUT_FAILED, `conditional put failed for ${key}`, err);
    }
    const accepted = classifyPutResponse(response);
    if (accepted) return accepted;
    throw new CasError(CAS_ERROR_CODE.INVALID_RESPONSE,
        `conditional put for ${key} returned no acceptance signal`);
}

const FORK_VERDICTS = new Set([CAS_CLASSIFICATION.FORK_AUTHORITY_COLLISION,
    CAS_CLASSIFICATION.GENERATION_REGRESSION_FORK]);

// RETRY_ELIGIBLE is the only non-terminal branch; NO branch ever means "this writer's write succeeded".
function verdict(classification) {
    const retry = classification === CAS_CLASSIFICATION.RETRY_ELIGIBLE;
    return {
        classification, terminal: !retry, retry_eligible: retry, writer_success: false,
        fork: FORK_VERDICTS.has(classification), put_permitted: retry, cold_start_fallback_permitted: false
    };
}

const isGeneration = (v) => Number.isInteger(v) && v >= 0;
const isDigest = (v) => typeof v === 'string' && v.length > 0;

/** Pure O-1 contention classifier: no I/O, no clock, no randomness, no retry. */
export function classifyContentionState(input) {
    const i = input || {};
    const previous = i.previously_observed_generation;
    const intended = i.intended_generation;
    if (!isGeneration(previous) || !isGeneration(intended)) {
        throw new CasError(CAS_ERROR_CODE.INVALID_CLASSIFIER_INPUT,
            'previously_observed_generation and intended_generation must be non-negative integers');
    }
    if (!isDigest(i.intended_authority_identity_digest) || !isDigest(i.intended_record_digest)) {
        throw new CasError(CAS_ERROR_CODE.INVALID_CLASSIFIER_INPUT, 'intended digests are required');
    }
    if (intended <= previous) return verdict(CAS_CLASSIFICATION.INTENDED_GENERATION_NOT_NEW);
    const observed = i.new_generation;
    if (i.new_record_absent === true || !isGeneration(observed) ||
        !isDigest(i.new_authority_identity_digest) || !isDigest(i.new_record_digest)) {
        return verdict(CAS_CLASSIFICATION.CONTENTION_REREAD_INVALID);
    }
    if (observed > intended) return verdict(CAS_CLASSIFICATION.SUPERSEDED);
    if (observed === intended) {
        const same = i.new_authority_identity_digest === i.intended_authority_identity_digest &&
            i.new_record_digest === i.intended_record_digest;
        return verdict(same ? CAS_CLASSIFICATION.SUPERSEDED_BY_EQUIVALENT : CAS_CLASSIFICATION.FORK_AUTHORITY_COLLISION);
    }
    if (observed < previous) return verdict(CAS_CLASSIFICATION.GENERATION_REGRESSION_FORK);
    if (observed === previous) return verdict(CAS_CLASSIFICATION.CONTENTION_WITHOUT_OBSERVED_ADVANCE);
    return verdict(CAS_CLASSIFICATION.RETRY_ELIGIBLE);
}
