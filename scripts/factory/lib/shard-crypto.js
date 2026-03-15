/**
 * V5.8 Shard AES-CTR Encryption — Sovereign Encryption Layer
 * Per-entity encryption with offset-derived IV for range-read compatibility.
 *
 * Architecture: Each entity payload is independently encrypted so that
 * arbitrary range reads (offset, size) can be decrypted without streaming
 * the entire shard. IV = SHA-256(key || shardName || offset)[0:16].
 */
import crypto from 'crypto';

let _aesKey = null;

/**
 * Initialize AES-256-CTR encryption from environment.
 * @returns {boolean} true if encryption is active
 */
export function initShardCrypto() {
    const keyHex = process.env.AES_CRYPTO_KEY;
    if (!keyHex || keyHex.length < 64) {
        console.log('[SHARD-CRYPTO] AES_CRYPTO_KEY not set or < 32 bytes, encryption disabled');
        return false;
    }
    _aesKey = Buffer.from(keyHex.substring(0, 64), 'hex');
    console.log('[SHARD-CRYPTO] AES-256-CTR sovereign encryption enabled');
    return true;
}

export function isEncryptionEnabled() { return !!_aesKey; }

/**
 * Derive a deterministic IV per entity from shard name + byte offset.
 * Both build-time (Node crypto) and Edge (Web Crypto) must produce identical output.
 */
function deriveEntityIv(shardName, entityOffset) {
    return crypto.createHash('sha256')
        .update(_aesKey)
        .update(shardName)
        .update(String(entityOffset))
        .digest()
        .subarray(0, 16);
}

/**
 * Encrypt a single entity payload (post-Zstd) for shard storage.
 * @param {string} shardName - e.g. "fused-shard-000.bin"
 * @param {Buffer} payload - Zstd-compressed (or raw) entity bytes
 * @param {number} entityOffset - byte offset where this entity will be written
 * @returns {Buffer} encrypted payload (same length as input)
 */
export function encryptPayload(shardName, payload, entityOffset) {
    if (!_aesKey) return payload;
    const iv = deriveEntityIv(shardName, entityOffset);
    const cipher = crypto.createCipheriv('aes-256-ctr', _aesKey, iv);
    return Buffer.concat([cipher.update(payload), cipher.final()]);
}

/** AES-CTR is symmetric — decrypt is identical to encrypt */
export const decryptPayload = encryptPayload;
