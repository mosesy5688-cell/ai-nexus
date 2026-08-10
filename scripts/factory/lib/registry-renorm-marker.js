/**
 * OP-GR-B one-time completion marker (ruling D-2026-0810-418 SS1(a)).
 *
 * The marker is the FIRST of two independent one-time guards:
 *
 *   (a) THIS MARKER. A durable R2 object written ONLY after a fully verified
 *       rewrite. The step reads it first and skips itself when present, so the
 *       operation cannot repeat even while the Founder variable is still set.
 *   (b) THE FOUNDER VARIABLE. Revoked after a confirmed cycle.
 *
 * A THIRD guard is structural and needs no state at all: after a successful
 * re-normalisation the cohort is no longer giant, so the next run finds ZERO
 * giants, reconciles 274 census ids as MISSING, and self-abandons with zero
 * rewrites. Idempotence therefore does not DEPEND on the marker -- the marker
 * makes the skip explicit, cheap and auditable instead of implicit.
 *
 * Reading the marker is an R2 GET/HEAD. Writing it is the only production R2
 * write this lane performs outside the pipeline's own persistence.
 */

import { HeadObjectCommand, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

export const MARKER_KEY = 'state/op-gr-b/renorm-complete.json';

/** Marker lookup outcomes. UNKNOWN is fail-closed at the call site. */
export const MARKER = Object.freeze({ PRESENT: 'PRESENT', ABSENT: 'ABSENT', UNKNOWN: 'UNKNOWN' });

/**
 * Probe the marker.
 *
 * A missing object is ABSENT (proceed). Any other failure is UNKNOWN, never
 * ABSENT: an R2 error must not be read as permission to run a one-time
 * operation a second time.
 */
export async function readMarker(s3, bucket, key = MARKER_KEY) {
    try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { state: MARKER.PRESENT, key };
    } catch (err) {
        const status = err?.$metadata?.httpStatusCode;
        const name = err?.name || '';
        if (status === 404 || name === 'NotFound' || name === 'NoSuchKey') {
            return { state: MARKER.ABSENT, key };
        }
        return { state: MARKER.UNKNOWN, key, error: name || String(err?.message || err) };
    }
}

/** Fetch and parse the marker body (used by the skip path's log line). */
export async function fetchMarkerBody(s3, bucket, key = MARKER_KEY) {
    try {
        const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const chunks = [];
        for await (const c of res.Body) chunks.push(c);
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        return null;
    }
}

/**
 * Write the completion marker. Called ONLY after the post-transform
 * verification has passed; a failed or abandoned run must leave no marker so
 * the still-armed variable can drive a corrected retry next cycle.
 */
export async function writeMarker(s3, bucket, body, key = MARKER_KEY) {
    const payload = Buffer.from(JSON.stringify({ schema_version: 1, ...body }, null, 2) + '\n', 'utf8');
    await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: payload, ContentType: 'application/json',
    }));
    return { key, bytes: payload.length };
}
