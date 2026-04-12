/**
 * V25.8.7 PDF Fetcher — Marker Sidecar Client
 *
 * Downloads ArXiv PDFs to temp, sends path to the Marker sidecar,
 * reads structured Markdown back via stdin/stdout protocol.
 *
 * Protocol:
 *   Node → stdin:  /tmp/booster-2401.00001.pdf\n
 *   Python → stdout: <MARKER_START>\n...markdown...\n<MARKER_END>\n
 *   Error: <MARKER_ERROR>\n
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { createInterface } from 'readline';

const ARXIV_PDF_BASE = 'https://arxiv.org/pdf';
const PDF_TMP_DIR = process.env.RUNNER_TEMP || '/tmp';
const PDF_MAX_SIZE = 50 * 1024 * 1024; // 50MB cap
const PDF_TIMEOUT_MS = 60000;
const MARKER_TIMEOUT_MS = 20 * 60 * 1000; // 20 min — large PDFs (500+ pages) need this

let sidecar = null;
let rl = null;
let lineBuffer = [];
let waitingResolve = null;

// ── Sidecar Lifecycle ───────────────────────────────────
export function initMarkerSidecar() {
    return new Promise((resolve) => {
        console.log('[PDF] Starting Marker sidecar...');
        sidecar = spawn('python3', [
            path.resolve('scripts/sidecar/marker-sidecar.py')
        ], { stdio: ['pipe', 'pipe', 'pipe'] });

        sidecar.stderr.on('data', (d) => {
            const msg = d.toString().trim();
            if (msg) console.log(`[MARKER] ${msg}`);
            if (msg.includes('Ready')) resolve(true);
        });

        sidecar.on('error', (e) => {
            console.error(`[PDF] Sidecar spawn error: ${e.message}`);
            sidecar = null;
            resolve(false);
        });

        sidecar.on('exit', (code) => {
            console.warn(`[PDF] Sidecar exited with code ${code}`);
            sidecar = null;
        });

        // Line-based stdout reader
        rl = createInterface({ input: sidecar.stdout });
        rl.on('line', (line) => {
            lineBuffer.push(line);
            if (line.startsWith('<MARKER_END:') || line.startsWith('<MARKER_ERROR:')) {
                if (waitingResolve) {
                    const cb = waitingResolve;
                    waitingResolve = null;
                    cb(lineBuffer.splice(0));
                }
            }
        });

        // V25.8.9: Timeout fallback if sidecar never prints "Ready".
        // Must exceed Marker cold-start (~2m49s observed in run 24280140876:
        // 1.34GB model download + PyTorch load + "Ready" print). GHA runners
        // are ephemeral so every run is cold start — 120s was 49s too short
        // and PDF fallback was silently disabled on every 1.5 run since V25.8.7.
        setTimeout(() => resolve(false), 300000);
    });
}

export function shutdownMarkerSidecar() {
    if (sidecar) {
        sidecar.stdin.end();
        sidecar.kill('SIGTERM');
        sidecar = null;
    }
}

// ── Core: Download + Convert ────────────────────────────
function waitForMarkerResponse() {
    return new Promise((resolve) => {
        waitingResolve = resolve;
        // Timeout safety
        setTimeout(() => {
            if (waitingResolve) {
                waitingResolve = null;
                resolve(['<MARKER_TIMEOUT>']);
            }
        }, MARKER_TIMEOUT_MS);
    });
}

export async function fetchArxivPdf(arxivId) {
    if (!sidecar) return null;

    const url = `${ARXIV_PDF_BASE}/${arxivId}`;
    const tmpPath = path.join(PDF_TMP_DIR, `booster-${arxivId.replace(/\//g, '_')}.pdf`);

    try {
        // 1. Download PDF
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
            signal: AbortSignal.timeout(PDF_TIMEOUT_MS)
        });
        if (!res.ok) return null;

        const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
        if (contentLength > PDF_MAX_SIZE) {
            console.warn(`[PDF] Too large (${(contentLength/1024/1024).toFixed(1)}MB): ${arxivId}`);
            return null;
        }

        await pipeline(res.body, fs.createWriteStream(tmpPath));

        // 2. Send to Marker sidecar
        sidecar.stdin.write(tmpPath + '\n');

        // 3. Wait for response
        const lines = await waitForMarkerResponse();

        // Timeout — sidecar may still be processing; drain buffer on next call
        if (lines[0] === '<MARKER_TIMEOUT>') {
            console.warn(`[PDF] Marker timeout (${MARKER_TIMEOUT_MS/1000}s) for ${arxivId}`);
            return null;
        }

        const lastLine = lines[lines.length - 1] || '';

        // 4. Validate paper ID — prevent data corruption from protocol desync
        if (lastLine.startsWith('<MARKER_ERROR:')) {
            // Check if error belongs to this paper
            if (!lastLine.includes(tmpPath)) {
                console.warn(`[PDF] Protocol desync: expected ${tmpPath}, got ${lastLine}. Discarding.`);
                lineBuffer = [];
                return null;
            }
            return null;
        }

        // Find start delimiter with matching path
        const startIdx = lines.findIndex(l => l === `<MARKER_START:${tmpPath}>`);
        const endIdx = lines.findIndex(l => l === `<MARKER_END:${tmpPath}>`);

        if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
            // Response belongs to a different paper — protocol is desynced
            if (lines.some(l => l.startsWith('<MARKER_START:'))) {
                console.warn(`[PDF] Protocol desync for ${arxivId}. Discarding stale response.`);
            }
            lineBuffer = [];
            return null;
        }

        const markdown = lines.slice(startIdx + 1, endIdx).join('\n');
        return markdown.length >= 200 ? markdown : null;

    } catch (e) {
        if (e.name !== 'AbortError') console.warn(`[PDF] Error for ${arxivId}: ${e.message}`);
        return null;
    } finally {
        try { fs.unlinkSync(tmpPath); } catch {}
    }
}
