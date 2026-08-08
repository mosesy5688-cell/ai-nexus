/**
 * PROCESS_SHARD consumer-side preflight gate — I/O composition (D-2026-0806-404 R3).
 *
 * Extracted verbatim from scripts/factory/shard-processor.js under
 * D-2026-0808-405 A1 ① purely to restore CES Art 5.1 headroom (the entry file
 * sat at 248/250). BEHAVIOUR IS UNCHANGED: same call order, same operands, same
 * telemetry line, same thrown message. The DECISION RULE — comparisonFactor 1.0
 * and the 512 MiB reserve — lives in ./shard-memory-gate.js and is NOT touched
 * here; this file only wires the streams and the operands into it.
 *
 * WHY THE CEILINGS ARE PARAMETERS, NOT MODULE CONSTANTS
 * shard-oom-deployed-wiring.test.mjs proves the R2a pin is falsifiable by
 * neutering the ceiling literals INSIDE the deployed shard-processor.js text.
 * Passing both ceilings in from that call site keeps the deployed wiring
 * visible — and mutable — exactly where that test expects to find it. Hoisting
 * them into this module would silently make that mutation a no-op for the gate.
 */

import fsSync from 'fs';
import os from 'os';
import { readNdjsonLines, READER_RETAINED_CAP_BYTES } from './ndjson-byte-reader.js';
import { evaluateShardMemoryGate, projectShardPeakHeapBytes, scanShardProfile, formatShardGateTelemetry } from './shard-memory-gate.js';
import { createAutoDecompressStream } from './zstd-helper.js';
import { readOldSpaceLimitBytes } from './runner-capacity-preflight.mjs';

/**
 * Bounded prefix scan of line byte lengths (no parse), then the R3 decision
 * rule. Detection only; R1 is the repair.
 *
 * Throws the R3 named terminal when the gate fails closed, and propagates
 * RecordSizeLimitExceededError from the scan itself unchanged.
 *
 * @param {object}  o
 * @param {number}  o.shardId             shard index, for telemetry + terminals
 * @param {string}  o.shardFilePath       consolidated shard input path
 * @param {number}  o.maxRecordBytes      reader-side per-record ceiling (R2a)
 * @param {number}  o.recordCeilingBytes  gate-side independent record criterion
 * @returns {Promise<{gateProfile: object, gateDecision: object}>}
 */
export async function runProcessShardPreflightGate({
    shardId,
    shardFilePath,
    maxRecordBytes,
    recordCeilingBytes,
} = {}) {
    const gateRs = fsSync.createReadStream(shardFilePath);
    const gateProfile = await scanShardProfile(
        readNdjsonLines(gateRs.pipe(createAutoDecompressStream()), {
            shardId, inputIdentity: shardFilePath, maxRecordBytes,
        })
    );
    gateRs.destroy();
    const gateDecision = evaluateShardMemoryGate({
        phase: 'PROCESS_SHARD',
        projectedPeakHeapBytes: projectShardPeakHeapBytes({
            baseContextBytes: process.memoryUsage().heapUsed,
            readerRetainedCapBytes: READER_RETAINED_CAP_BYTES,
            maxRecordBytes: gateProfile.maxRecordBytes,
        }),
        oldSpaceLimitBytes: readOldSpaceLimitBytes(),
        availableRamBytes: os.totalmem(),
        maxRecordBytes: gateProfile.maxRecordBytes,
        recordCeilingBytes,
    });
    console.log(formatShardGateTelemetry(shardId, gateProfile, gateDecision));
    if (!gateDecision.ok) {
        throw new Error(`${gateDecision.terminalCode}: shard=${shardId} input=${shardFilePath} ` +
            `reasons=${gateDecision.reasons.join(',')} projected=${gateDecision.projectedPeakHeapBytes} ` +
            `usable=${gateDecision.usableBytes} maxRecordBytes=${gateProfile.maxRecordBytes}`);
    }
    return { gateProfile, gateDecision };
}
