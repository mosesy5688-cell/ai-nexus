// tests/unit/vfs-pack-cache-version.test.ts
// P3-EVIDENCE-1 STAGE-B — VFS PACK CACHE VERSIONING invariant (Commit-B).
//
// The repaired row-builders citation authority must not be silently SKIPPED on a
// re-run that restores a pre-repair vfs-pack cache. Defense = a frozen
// VFS_PACK_CODE_VERSION token that scopes every intra-4-4-vfs-pack cache key + a
// version sentinel the skip-gate must match exactly. These are CONFIG/SOURCE asserts
// over .github/workflows/factory-upload.yml (read as text; hermetic, no YAML dep, no
// network) so a drift that lets an old/missing/mismatched version trigger skip — or
// that busts the intentionally-warm fusion/embedding caches — fails the gate.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const WF = path.resolve(__dirname, '../../.github/workflows/factory-upload.yml');
const yml = fs.readFileSync(WF, 'utf8');
// Resolve the frozen version value from the env declaration (single source).
const versionDecl = yml.match(/VFS_PACK_CODE_VERSION:\s*'([^']+)'/);
const VERSION = versionDecl ? versionDecl[1] : '';

// All intra-4-4-vfs-pack `key:` / restore-key prefixes in the workflow.
function vfsPackKeyLines(): string[] {
    return yml.split('\n').map(l => l.trim()).filter(l => l.includes('intra-4-4-vfs-pack-') && !l.startsWith('#'));
}

describe('STAGE-B vfs-pack cache versioning — frozen token', () => {
    it('declares a frozen VFS_PACK_CODE_VERSION token in env', () => {
        expect(versionDecl).not.toBeNull();
        expect(VERSION.length).toBeGreaterThan(0);
        // Frozen value for this remediation (bump-on-code-change discipline).
        expect(VERSION).toBe('citation-authority-v2');
    });

    it('EVERY intra-4-4-vfs-pack cache key/restore-prefix carries the version token', () => {
        const lines = vfsPackKeyLines();
        expect(lines.length).toBeGreaterThanOrEqual(3); // restore + save + vfs-derived restore
        for (const l of lines) {
            expect(l).toContain('intra-4-4-vfs-pack-${{ env.VFS_PACK_CODE_VERSION }}-');
        }
    });

    it('no vfs-pack key uses the bare (unversioned) prefix', () => {
        // A bare `intra-4-4-vfs-pack-<run-id>` (without the version segment) would let a
        // restore cross packer-code versions. Assert none exist.
        const bare = /intra-4-4-vfs-pack-\$\{\{\s*needs\.check-upstream/;
        expect(bare.test(yml)).toBe(false);
    });
});

describe('STAGE-B vfs-pack cache versioning — sentinel + skip gate', () => {
    it('a fresh pack writes the version sentinel file (output/meta/) from the token', () => {
        expect(yml).toContain('output/meta/vfs-pack-code-version.txt');
        // Written by the packer step, sourced from the env token (not a literal).
        expect(yml).toMatch(/printf '%s' "\$VFS_PACK_CODE_VERSION" > output\/meta\/vfs-pack-code-version\.txt/);
        // The sentinel path is inside output/meta/, which IS in the vfs-pack save paths.
        const saveIdx = yml.indexOf('Save VFS Pack Output to Cache');
        const saveBlock = yml.slice(saveIdx, saveIdx + 600);
        expect(saveBlock).toContain('output/meta/');
    });

    it('skip-gate requires ALL: meta>=20 AND mesh graph AND sentinel == version', () => {
        const detectIdx = yml.indexOf('Detect vfs-pack output present');
        expect(detectIdx).toBeGreaterThan(0);
        const block = yml.slice(detectIdx, detectIdx + 1600);
        // meta count threshold
        expect(block).toMatch(/META_COUNT.*-ge 20|"\$META_COUNT" -ge 20/);
        // mesh graph presence
        expect(block).toContain('output/cache/mesh/graph.json');
        // sentinel must equal the current version for skip=true
        expect(block).toContain('"$SENTINEL_VAL" = "$VFS_PACK_CODE_VERSION"');
        // skip=true ONLY in the branch gated by all three (sentinel equality present)
        expect(block).toContain('skip_compute=true');
    });

    it('missing OR mismatched sentinel forces compute (skip_compute=false default branch)', () => {
        const detectIdx = yml.indexOf('Detect vfs-pack output present');
        const block = yml.slice(detectIdx, detectIdx + 1600);
        // The skip=true is in an elif guarded by sentinel equality; any other path
        // (no sentinel, wrong sentinel, too few meta, no mesh) falls to else -> false.
        expect(block).toContain('SENTINEL_VAL=""');           // defaults empty when no file
        expect(block).toMatch(/else[\s\S]*skip_compute=false/); // else branch forces compute
    });

    it('force_fresh == true forces unconditional compute (cache ignored)', () => {
        const detectIdx = yml.indexOf('Detect vfs-pack output present');
        const block = yml.slice(detectIdx, detectIdx + 1600);
        expect(block).toContain('FORCE_FRESH: ${{ inputs.force_fresh }}');
        // first branch: force_fresh -> skip_compute=false regardless of cache state
        expect(block).toMatch(/if \[ "\$FORCE_FRESH" = "true" \][\s\S]*?skip_compute=false/);
    });

    it('the fresh-pack step overwrites restored rows (pack-db runs then stamps sentinel)', () => {
        const execIdx = yml.indexOf('Execute Stable 1.0 Packer');
        const block = yml.slice(execIdx, execIdx + 1400);
        // condition: only when not skipping (which is also the force_fresh path)
        expect(block).toContain("skip_compute != 'true'");
        // pack-db.js runs BEFORE the sentinel is stamped (sentinel only on success)
        const packPos = block.indexOf('node scripts/factory/pack-db.js');
        const sentinelPos = block.indexOf('vfs-pack-code-version.txt');
        expect(packPos).toBeGreaterThan(0);
        expect(sentinelPos).toBeGreaterThan(packPos);
    });
});

describe('STAGE-B vfs-pack cache versioning — fusion/embedding caches untouched', () => {
    it('fused cache keys do NOT carry VFS_PACK_CODE_VERSION (warm reuse preserved)', () => {
        const fusedLines = yml.split('\n').filter(l => l.includes('intra-4-4-fused-'));
        expect(fusedLines.length).toBeGreaterThan(0);
        for (const l of fusedLines) expect(l).not.toContain('VFS_PACK_CODE_VERSION');
    });

    it('embedding-shards cache keys keep EMBED_CODE_VERSION, not VFS_PACK_CODE_VERSION', () => {
        const embedLines = yml.split('\n').filter(l => l.includes('embedding-shards-'));
        expect(embedLines.length).toBeGreaterThan(0);
        for (const l of embedLines) {
            expect(l).toContain('EMBED_CODE_VERSION');
            expect(l).not.toContain('VFS_PACK_CODE_VERSION');
        }
    });

    it('baked profile-shard cache keys are unchanged (no VFS_PACK_CODE_VERSION)', () => {
        const bakedLines = yml.split('\n').filter(l => l.includes('intra-4-4-baked-'));
        expect(bakedLines.length).toBeGreaterThan(0);
        for (const l of bakedLines) expect(l).not.toContain('VFS_PACK_CODE_VERSION');
    });
});
