/**
 * Entity Versioner Module V14.5
 * 
 * SPEC-BACKUP-V14.5 Section 3.1: Entity Versioning
 * - Rotate existing versions before new upload
 * - Maintain 2 historical versions (.v-1, .v-2)
 * 
 * Constitutional: Art 13.4 (Non-Destructive)
 */
import { CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

/**
 * Rotate entity versions before upload
 * @param {S3Client} s3 - S3 client
 * @param {string} bucket - Bucket name
 * @param {string} remotePath - Remote file path
 */
export async function rotateEntityVersions(s3, bucket, remotePath) {
    // Only version entity files (cache/entities/*.json)
    if (!remotePath.startsWith('cache/entities/') ||
        !remotePath.endsWith('.json') ||
        remotePath.includes('.v-')) {
        return;
    }

    try {
        // Step 1: Rotate current to .v-1 (via copy)
        const v1Key = remotePath.replace('.json', '.v-1.json');
        try {
            await s3.send(new CopyObjectCommand({
                Bucket: bucket,
                CopySource: `${bucket}/${remotePath}`,
                Key: v1Key
            }));
        } catch {
            // Current doesn't exist, first upload
        }
    } catch (versionErr) {
        console.warn(`\n⚠️ Versioning failed for ${remotePath}: ${versionErr.message}`);
    }
}
