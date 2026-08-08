/**
 * Byte-bounded NDJSON line reader (D-2026-0806-404, repairs R1 + R2a).
 *
 * WHY THIS EXISTS
 * The previous shard input path was `for await (const line of readline)`.
 * readline's async iterator read-ahead is COUNT-bounded (~1,024 queued lines)
 * with ZERO byte accounting. Against the positional band of ~6 MiB/line records
 * that exists in every processing shard at intra-shard index ~15,500-18,500,
 * that queue retains ~1,026 x 6 MiB ~= 6,156 MiB, which is what drove the live
 * heap to 6,170.3 MiB (= 6.0257 GiB) against a 6,144 MiB old-space limit.
 *
 * This reader is BYTE-bounded instead. It pulls one chunk at a time from the
 * source stream (async iteration over a Readable honours backpressure), holds
 * at most ONE partial line plus the current chunk, and yields lines one at a
 * time so the consumer's await naturally throttles the producer.
 *
 * LINE SEMANTICS - matched to OBSERVED node readline behaviour, not to a model.
 * Erratum v2 B-1 measured real readline and found it normalises ALL THREE
 * terminator styles: LF, CRLF and bare CR are each terminators, CR is stripped
 * from CRLF, and no trailing empty line is emitted after a final terminator.
 * This reader reproduces exactly that, so line arrays are identical.
 *
 * R2a - FAIL-CLOSED RECORD CEILING. A record whose byte length exceeds
 * MAX_RECORD_BYTES is NEVER parsed, NEVER truncated, NEVER skipped and NEVER
 * emitted. The reader stops retaining its bytes, keeps counting them to report
 * the EXACT measured size, and then throws RecordSizeLimitExceededError. No
 * record content is retained or logged.
 */

const MiB = 1024 * 1024;

// ---------------------------------------------------------------------------
// DECLARED, REVIEWABLE CONSTANTS. See the derivation in the lane return packet.
// ---------------------------------------------------------------------------

// R2a per-record ceiling. 64 MiB is ~10.7x the observed ~6 MiB band maximum, so
// it cannot false-fail a conforming record, and it is 12.5% of V8's ~512 MiB
// single-string limit, so an accepted record can always be parsed.
export const MAX_RECORD_BYTES = 64 * MiB;            // 67,108,864

// Chunk allowance held alongside the partial line while scanning for a
// terminator. 8 MiB is above the 64 KiB default highWaterMark with margin for
// a decompressor emitting larger chunks.
export const READER_CHUNK_ALLOWANCE_BYTES = 8 * MiB; // 8,388,608

// R1 cap: the maximum bytes this reader may retain at any instant.
export const READER_RETAINED_CAP_BYTES = MAX_RECORD_BYTES + READER_CHUNK_ALLOWANCE_BYTES; // 75,497,472

export const RECORD_SIZE_TERMINAL = 'SHARD_RECORD_SIZE_LIMIT_EXCEEDED';

/**
 * Thrown when a record crosses the declared ceiling. Carries ONLY identity and
 * measurement - never record content.
 */
export class RecordSizeLimitExceededError extends Error {
    constructor({ shardId, recordOrdinal, byteOffset, measuredBytes, ceilingBytes, inputIdentity }) {
        super(
            `${RECORD_SIZE_TERMINAL}: shard=${shardId} recordOrdinal=${recordOrdinal} ` +
            `byteOffset=${byteOffset} measuredBytes=${measuredBytes} ceilingBytes=${ceilingBytes} ` +
            `input=${inputIdentity}`
        );
        this.name = 'RecordSizeLimitExceededError';
        this.terminalCode = RECORD_SIZE_TERMINAL;
        this.shardId = shardId;
        this.recordOrdinal = recordOrdinal;
        this.byteOffset = byteOffset;
        this.measuredBytes = measuredBytes;
        this.ceilingBytes = ceilingBytes;
        this.inputIdentity = inputIdentity;
    }
}

const LF = 0x0a;
const CR = 0x0d;

/**
 * Split a buffer into complete lines using readline's normalisation.
 * Returns { lines, rest, consumed } where `rest` is the trailing partial line.
 * `pendingCR` handles a CR that ended the previous chunk: if the next byte is
 * LF it belongs to that CRLF pair and must not start a new empty line.
 */
function splitChunk(buf, pendingCR) {
    const lines = [];
    let start = 0;
    let i = 0;
    if (pendingCR && buf.length > 0 && buf[0] === LF) {
        // The LF completing a CRLF whose CR closed the previous chunk.
        start = 1;
        i = 1;
    }
    while (i < buf.length) {
        const b = buf[i];
        if (b === LF) {
            lines.push(buf.subarray(start, i).toString('utf8'));
            i += 1;
            start = i;
        } else if (b === CR) {
            lines.push(buf.subarray(start, i).toString('utf8'));
            if (i + 1 < buf.length && buf[i + 1] === LF) i += 2; else i += 1;
            start = i;
        } else {
            i += 1;
        }
    }
    return { lines, rest: buf.subarray(start) };
}

/** True when the buffer's last byte is a lone CR that may pair with a next-chunk LF. */
function endsWithLoneCR(buf) {
    return buf.length > 0 && buf[buf.length - 1] === CR;
}

/**
 * Byte-bounded async line generator.
 *
 * @param {AsyncIterable<Buffer>} source decompressed byte stream
 * @param {object} opts
 * @param {number|string} opts.shardId          identity for the terminal
 * @param {string}        opts.inputIdentity    immutable input identity (path/key)
 * @param {number}        opts.maxRecordBytes   R2a ceiling
 * @param {(n:number)=>void} [opts.onRetained]  observer for peak-retention tests
 * @yields {string} one line, CR/LF stripped, in input order
 */
export async function* readNdjsonLines(source, {
    shardId = 0,
    inputIdentity = 'unknown',
    maxRecordBytes = MAX_RECORD_BYTES,
    onRetained = null,
} = {}) {
    let partial = Buffer.alloc(0);
    let pendingCR = false;
    let recordOrdinal = 0;     // 1-based ordinal of the record being accumulated
    let byteOffset = 0;        // byte offset of the current record's first byte
    let consumedBytes = 0;     // total source bytes consumed
    // Set once a record crosses the ceiling: we stop retaining and only count.
    let overflow = null;

    const report = (extra) => {
        if (onRetained) onRetained(partial.length + extra);
    };

    for await (const chunk of source) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        report(buf.length);

        // A zero-length chunk carries no bytes and MUST NOT perturb reader state.
        // Recomputing pendingCR here would clear a CR carried from the previous
        // chunk, so a following LF would be read as a fresh terminator and a
        // spurious empty line emitted. Skip before any state update.
        if (buf.length === 0) continue;

        if (overflow) {
            // Discard-and-count mode: find this record's terminator without
            // retaining any of its bytes, so the reported size is EXACT and
            // memory stays bounded.
            const { lines, rest } = splitChunk(buf, pendingCR);
            pendingCR = endsWithLoneCR(buf);
            if (lines.length === 0) {
                overflow.measuredBytes += buf.length;
                consumedBytes += buf.length;
                continue;
            }
            overflow.measuredBytes += Buffer.byteLength(lines[0], 'utf8');
            throw new RecordSizeLimitExceededError({
                shardId,
                recordOrdinal: overflow.recordOrdinal,
                byteOffset: overflow.byteOffset,
                measuredBytes: overflow.measuredBytes,
                ceilingBytes: maxRecordBytes,
                inputIdentity,
            });
        }

        const joined = partial.length ? Buffer.concat([partial, buf]) : buf;
        const { lines, rest } = splitChunk(joined, pendingCR && partial.length === 0);
        pendingCR = endsWithLoneCR(joined);

        for (const line of lines) {
            recordOrdinal += 1;
            const lineBytes = Buffer.byteLength(line, 'utf8');
            if (lineBytes > maxRecordBytes) {
                throw new RecordSizeLimitExceededError({
                    shardId,
                    recordOrdinal,
                    byteOffset,
                    measuredBytes: lineBytes,
                    ceilingBytes: maxRecordBytes,
                    inputIdentity,
                });
            }
            byteOffset += lineBytes + 1;
            yield line;
        }

        if (rest.length > maxRecordBytes) {
            // The in-flight record already exceeds the ceiling. Stop retaining
            // it; count the remainder to report the exact measured size.
            overflow = {
                recordOrdinal: recordOrdinal + 1,
                byteOffset,
                measuredBytes: rest.length,
            };
            partial = Buffer.alloc(0);
        } else {
            partial = Buffer.from(rest);
        }
        consumedBytes += buf.length;
        report(0);
    }

    if (overflow) {
        throw new RecordSizeLimitExceededError({
            shardId,
            recordOrdinal: overflow.recordOrdinal,
            byteOffset: overflow.byteOffset,
            measuredBytes: overflow.measuredBytes,
            ceilingBytes: maxRecordBytes,
            inputIdentity,
        });
    }
    // Final line without a trailing terminator. readline emits it; a trailing
    // terminator leaves `partial` empty and emits nothing, which matches.
    if (partial.length > 0) {
        recordOrdinal += 1;
        const lineBytes = partial.length;
        if (lineBytes > maxRecordBytes) {
            throw new RecordSizeLimitExceededError({
                shardId, recordOrdinal, byteOffset,
                measuredBytes: lineBytes, ceilingBytes: maxRecordBytes, inputIdentity,
            });
        }
        yield partial.toString('utf8');
    }
    void consumedBytes;
}
