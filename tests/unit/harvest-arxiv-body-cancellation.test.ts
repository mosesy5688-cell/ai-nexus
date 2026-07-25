import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// BLOCKING-1 regression barrier. An in-process fake cannot prove that a breached
// body releases its SOCKET, and that is precisely the property that was wrong:
// response.text() locks the stream, so response.body.cancel() rejects with
// ERR_INVALID_STATE and the cancellation is a silent no-op. The body was merely
// abandoned, the socket stayed open, and because harvest-single's main() has no
// process.exit(0) a completed harvest would hang until the runner killed the step
// -- a no-sidecar death, exactly what the terminalization reserve exists to prevent.
//
// So this runs a REAL localhost server in a CHILD process and asserts the child
// exits on its own. A retained handle shows up as a timeout, not a soft assertion.

const ADAPTERS = path.resolve('scripts/ingestion/adapters').replace(/\\/g, '/');

const PROBE = `
import http from 'node:http';
import { readBodyWithinDeadline } from 'file:///${ADAPTERS}/arxiv-response-deadline.js';

function makeServer(mode) {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    if (mode === 'complete') { res.end('<?xml version="1.0"?><OAI-PMH><ListRecords></ListRecords></OAI-PMH>'); return; }
    res.write('<?xml version="1.0"?><OAI-PMH>');
    if (mode === 'stall') return;                       // headers, then silence
    const t = setInterval(() => { try { res.write('<pad/>'); } catch { clearInterval(t); } }, 20);
    req.on('close', () => clearInterval(t));            // trickle: never idle
  });
}
async function run(mode, remainingMs, label) {
  const s = makeServer(mode);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const t0 = Date.now();
  const response = await fetch('http://127.0.0.1:' + s.address().port + '/');
  const out = await readBodyWithinDeadline({ response, remainingMs });
  const elapsed = Date.now() - t0;
  s.close();
  console.log((label || mode) + ' ok=' + out.ok + ' errorKind=' + (out.errorKind || '-') + ' elapsed=' + elapsed + 'ms');
  return { out, elapsed };
}
const stall = await run('stall', 200);
const trickle = await run('trickle', 200);
const done = await run('complete', 2000);
// FOURTH, INDEPENDENTLY REACHABLE CANCELLATION SITE (M37): remainingMs <= 0, i.e.
// the header phase consumed the WHOLE attempt window -- a realistic slow-tail shape
// and exactly the incident class this P0 exists for. No body read is attempted, so
// the socket is released only by the spent-path cancel. Without it: RETAINED=
// ["TCPSocketWrap"], HANDLE_PROBE=FAIL, exit 124.
const spent = await run('trickle', 0, 'spent');
if (stall.out.ok || trickle.out.ok || spent.out.ok) { console.log('CONTRACT=FAIL'); process.exit(3); }
if (stall.out.errorKind !== 'abort' || trickle.out.errorKind !== 'abort' || spent.out.errorKind !== 'abort') { console.log('KIND=FAIL'); process.exit(4); }
if (!done.out.ok || !done.out.text.includes('ListRecords')) { console.log('SUCCESS_PATH=FAIL'); process.exit(5); }
if (stall.elapsed > 900 || trickle.elapsed > 900) { console.log('BOUND=FAIL'); process.exit(6); }
await new Promise((r) => setTimeout(r, 400));
const sockets = process.getActiveResourcesInfo().filter((h) => /TCP|Socket/i.test(h));
console.log('RETAINED_SOCKET_HANDLES=' + JSON.stringify(sockets));
console.log(sockets.length === 0 ? 'HANDLE_PROBE=PASS' : 'HANDLE_PROBE=FAIL');
// NO process.exit() here: the child must drain and exit ON ITS OWN, exactly as
// harvest-single's success path does. A leaked socket therefore times out below.
`;

describe('BLOCKING-1 — a breached OAI body releases its socket (real server, child process)', () => {
    it('CANCEL-REAL stalled and trickling bodies abort in bounds, the success path still works, and NO handle is retained', () => {
        const file = path.join(os.tmpdir(), `arxiv-body-cancel-probe-${process.pid}.mjs`);
        fs.writeFileSync(file, PROBE, 'utf8');
        let stdout = '';
        try {
            // timeout is the assertion: an unreleased socket keeps the child alive.
            stdout = execFileSync(process.execPath, [file], { timeout: 20000, encoding: 'utf8' });
        } finally {
            fs.rmSync(file, { force: true });
        }
        expect(stdout).toContain('HANDLE_PROBE=PASS');
        expect(stdout).toContain('RETAINED_SOCKET_HANDLES=[]');
        expect(stdout).toMatch(/stall ok=false errorKind=abort/);
        expect(stdout).toMatch(/trickle ok=false errorKind=abort/);
        expect(stdout).toMatch(/complete ok=true/);
        // M37: the spent-path (remainingMs <= 0) cancellation site, exercised against
        // a real socket. Its absence hangs the child, so this line only passes if the
        // spent-path cancel actually released the connection.
        expect(stdout).toMatch(/spent ok=false errorKind=abort/);
    }, 40000);
});
