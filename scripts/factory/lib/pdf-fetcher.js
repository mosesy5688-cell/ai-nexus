/**
 * V25.8.4 PDF Fetcher - ArXiv PDF Download & Full-Text Extraction
 *
 * Stream-downloads PDF to temp file, extracts full text via pdf-parse,
 * then cleans up. Memory-safe: only one PDF in memory at a time.
 */

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const ARXIV_PDF_BASE = 'https://arxiv.org/pdf';
const PDF_TMP_DIR = process.env.RUNNER_TEMP || '/tmp';
const PDF_MAX_SIZE = 50 * 1024 * 1024; // 50MB cap
const PDF_TIMEOUT_MS = 60000; // 60s for full PDF download

/**
 * Download ArXiv PDF, extract full text, cleanup temp file.
 * @param {string} arxivId - e.g. "2401.00001"
 * @returns {string|null} Full text or null on failure
 */
export async function fetchArxivPdf(arxivId) {
    const url = `${ARXIV_PDF_BASE}/${arxivId}`;
    const tmpPath = path.join(PDF_TMP_DIR, `booster-${arxivId.replace(/\//g, '_')}.pdf`);
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Free2AITools-Booster/1.5' },
            signal: AbortSignal.timeout(PDF_TIMEOUT_MS)
        });
        if (!res.ok) return null;

        // Check Content-Length to skip oversized PDFs
        const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
        if (contentLength > PDF_MAX_SIZE) {
            console.warn(`[PDF] Too large (${(contentLength/1024/1024).toFixed(1)}MB): ${arxivId}`);
            return null;
        }

        // Stream to temp file (memory-safe)
        await pipeline(res.body, fs.createWriteStream(tmpPath));

        // Extract full text from PDF
        const dataBuffer = fs.readFileSync(tmpPath);
        const pdfData = await pdfParse(dataBuffer);
        return pdfData.text || null;
    } catch (e) {
        if (e.name !== 'AbortError') console.warn(`[PDF] Fetch error for ${arxivId}: ${e.message}`);
        return null;
    } finally {
        // Always cleanup temp file
        try { fs.unlinkSync(tmpPath); } catch {}
    }
}
