// V27.41: pack-db.js timing instrumentation helpers
// Output: [VFS-PROF] lines for grep-friendly extraction from cron logs

let _t0 = 0, _lastTs = 0, _lastPacked = 0;

export function startBatchProf() {
    _t0 = Date.now();
    _lastTs = _t0;
    _lastPacked = 0;
}

export function tickBatch(packed) {
    if (packed === 0 || packed % 50000 !== 0) return;
    const now = Date.now();
    const batchSec = (now - _lastTs) / 1000;
    const batchRate = ((packed - _lastPacked) / batchSec).toFixed(0);
    const totalSec = (now - _t0) / 1000;
    const totalRate = (packed / totalSec).toFixed(0);
    const heapMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0);
    console.log(`[VFS-PROF] @${packed}: batch=${batchSec.toFixed(1)}s (${batchRate} e/sec), cumulative=${totalSec.toFixed(0)}s (${totalRate} e/sec), heap=${heapMB}MB`);
    _lastTs = now;
    _lastPacked = packed;
}

export async function phaseT(name, fn) {
    const t = Date.now();
    const r = await fn();
    console.log(`[VFS-PROF] phase=${name}: ${Date.now() - t}ms`);
    return r;
}
