// scripts/debug/test-vfs-alignment.js
// VFS Verification Probe

async function testAlignment() {
    const target = 'http://localhost:4321/api/vfs-proxy/content.db';
    console.log(`[VFS-TEST] Probing ALIGNMENT on ${target}...`);

    try {
        // Test 8KB Aligned Range
        const res = await fetch(target, {
            headers: { 'Range': 'bytes=8192-16383' }
        });

        console.log(`[VFS-TEST] Status: ${res.status}`);
        console.log(`[VFS-TEST] Version: ${res.headers.get('x-vfs-proxy-ver')}`);

        if (res.status === 206) {
            console.log('✅ PASS: Aligned 8KB request accepted.');
        } else {
            console.log('❌ FAIL: Expected 206 Partial Content.');
            const text = await res.text();
            console.log(`[VFS-TEST] Body: ${text}`);
        }

        // Test Misaligned Range
        const res2 = await fetch(target, {
            headers: { 'Range': 'bytes=100-200' }
        });
        console.log(`[VFS-TEST] Misaligned Probe (100-200) Status: ${res2.status}`);
        if (res2.status === 206) {
            console.log('✅ PASS: Small probe allowed.');
        } else {
            console.log('❌ FAIL: Small probe should be allowed for integrity checks.');
        }

    } catch (e) {
        console.error(`[VFS-TEST] Error: ${e.message}`);
        console.log('NOTE: Ensure dev server is running on port 4321');
    }
}

testAlignment();
