/**
 * V5.8 Shard AES-CTR Decryption — Edge Worker Sovereign Decryption
 * Mirrors shard-crypto.js IV derivation for range-read compatibility.
 * Uses Web Crypto API (Cloudflare Workers / Browser compatible).
 */

let _importedKey: CryptoKey | null = null;
let _rawKey: Uint8Array | null = null;

export async function initShardDecrypt(keyHex: string): Promise<boolean> {
    if (_importedKey) return true;
    if (!keyHex || keyHex.length < 64) return false;
    const hex = keyHex.substring(0, 64);
    const bytes = hex.match(/.{2}/g)!.map(b => parseInt(b, 16));
    _rawKey = new Uint8Array(bytes);
    _importedKey = await crypto.subtle.importKey(
        'raw', _rawKey.buffer as ArrayBuffer, 'AES-CTR', false, ['decrypt']
    );
    return true;
}

/**
 * Derive IV identical to Node.js shard-crypto.js:
 * SHA-256(key || shardName || String(offset))[0:16]
 */
async function deriveEntityIv(shardName: string, entityOffset: number): Promise<Uint8Array> {
    const enc = new TextEncoder();
    const parts = [_rawKey!, enc.encode(shardName), enc.encode(String(entityOffset))];
    const total = parts.reduce((s, p) => s + p.length, 0);
    const data = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) { data.set(p, pos); pos += p.length; }
    const hash = await crypto.subtle.digest('SHA-256', data);
    return new Uint8Array(hash).subarray(0, 16);
}

/**
 * Decrypt a range-read entity payload from an encrypted shard.
 * @param shardName - e.g. "fused-shard-000.bin"
 * @param ciphertext - encrypted bytes from R2 range read
 * @param entityOffset - byte offset (matches Range header start)
 */
export async function decryptShardRange(
    shardName: string, ciphertext: ArrayBuffer, entityOffset: number
): Promise<ArrayBuffer> {
    if (!_importedKey) return ciphertext;
    const iv = await deriveEntityIv(shardName, entityOffset);
    return crypto.subtle.decrypt(
        { name: 'AES-CTR', counter: iv.buffer as ArrayBuffer, length: 128 },
        _importedKey,
        ciphertext
    );
}
