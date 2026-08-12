// PR-GR-C (ruling D-2026-0812-421): the EMBEDDED CENSUS v2, pinned.
//
// WHAT WENT WRONG, AND WHAT THIS FILE DEFENDS
// Schema v1 embedded EXPORT-layer ids (`kaggle-dataset--<tail>`, as spelled in
// merged_shard_*.json.zst) while the step scans the REGISTRY layer
// (`hf-dataset--<tail>`, as minted by registry-manager.js mergeCurrentBatch via
// getNodeSource, which returns 'hf' for EVERY dataset regardless of the record's
// own `source`). The two layers disagree BY CONSTRUCTION, so the census could
// never match: run 31563250233 self-abandoned on 274 missing / 274 extra with an
// exact tail bijection. These tests make that class of error loud:
//   - the file must DECLARE the layer it matches, and loadCensus fails closed
//     if the declaration is missing or wrong;
//   - the id list is pinned by sha256, so tampering REDs;
//   - both spellings and the tail are carried, so the two layers stay visible.
//
// HERMETIC: reads the repo's own JSON. No network, no credentials, no R2.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadCensus, CENSUS_LAYER } from './lib/registry-renorm-core.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENSUS_PATH = path.join(HERE, 'lib', 'op-gr-b-giant-cohort.json');
const doc = JSON.parse(fs.readFileSync(CENSUS_PATH, 'utf8'));

// The census v2 id list, as ratified by D-2026-0812-421 from the delta forensics.
const PINNED_SHA = 'e0c9cb74c381f407861016f7913a9f72a3ba09ce0c5542dcd58946c41fc8dd6a';
const listSha = (ids) => crypto.createHash('sha256').update([...ids].sort().join('\n')).digest('hex');

test('X1 the census declares schema v2 and the layer reconcile matches', () => {
    assert.equal(doc.schema_version, 2);
    assert.equal(doc.matches_layer, CENSUS_LAYER);
    assert.equal(CENSUS_LAYER, 'registry');
    assert.ok(String(doc.matches_layer_note || '').length > 0,
        'the layer choice must be explained in the file, not only in a ruling');
});

test('X2 the id list is EXACTLY the ratified set (sha256 pin -- tampering REDs)', () => {
    const ids = doc.records.map((r) => r.id);
    assert.equal(ids.length, 274);
    assert.equal(new Set(ids).size, 274, 'no duplicate ids in the census');
    assert.equal(listSha(ids), PINNED_SHA);
    assert.equal(doc.census_v2_id_list_sha256, PINNED_SHA,
        'the file must carry its own list hash, and it must agree with the pin');
});

test('X3 every row carries BOTH layer spellings plus the invariant tail', () => {
    for (const r of doc.records) {
        assert.ok(r.id.startsWith('hf-dataset--'), `registry-layer id: ${r.id}`);
        assert.ok(r.export_layer_id.startsWith('kaggle-dataset--'), `export-layer id: ${r.export_layer_id}`);
        assert.equal(r.id, `hf-dataset--${r.tail}`);
        assert.equal(r.export_layer_id, `kaggle-dataset--${r.tail}`);
        assert.ok(Number.isInteger(r.census_bytes) && r.census_bytes >= 32 * 1024 * 1024);
        assert.ok(r.band === 'ge_64mib' || r.band === 'from_32_to_64mib');
    }
});

test('X4 the tail set is a bijection with the v1 export-layer census', () => {
    // The whole diagnosis rests on this: same records, two spellings.
    const tails = new Set(doc.records.map((r) => r.tail));
    const fromExport = new Set(doc.records.map((r) => r.export_layer_id.slice('kaggle-dataset--'.length)));
    assert.equal(tails.size, 274);
    assert.deepEqual([...tails].sort(), [...fromExport].sort());
});

test('X5 header counts and bands agree with the rows', () => {
    assert.equal(doc.count, doc.records.length);
    const bands = doc.records.reduce((a, r) => (a[r.band] = (a[r.band] || 0) + 1, a), {});
    assert.deepEqual(bands, { ge_64mib: 100, from_32_to_64mib: 174 });
    assert.deepEqual(doc.bands, { ge_64mib: 100, from_32_to_64mib: 174 });
    assert.equal(doc.forensics_sha256,
        '16c97d7eca66a31c7609d1d75601885236966937a85fa5de1eefb6573940efea',
        'v1 forensics provenance must stay pinned');
});

test('X6 the real file loads, and loadCensus FAILS CLOSED on a wrong/absent layer', () => {
    const c = loadCensus(doc);
    assert.equal(c.count, 274);
    assert.equal(c.ids.size, 274);

    // The exact regression that cost run 31563250233: an export-layer census.
    assert.throws(() => loadCensus({ ...doc, matches_layer: 'export' }),
        /OP_GR_B_CENSUS_LAYER_MISMATCH/,
        'an export-layer census must be refused, not silently reconciled to zero');
    const { matches_layer, ...noLayer } = doc;
    void matches_layer;
    assert.throws(() => loadCensus(noLayer), /OP_GR_B_CENSUS_LAYER_MISMATCH/,
        'an UNDECLARED layer is refused too -- silence is what made this invisible');
});

test('X7 reconcile still matches on the FULL id, not the tail (gate unchanged)', () => {
    // The ruling keeps the gate strict. Matching on the tail would have masked
    // the layer bug, and tails are not unique corpus-wide.
    const c = loadCensus(doc);
    const sample = doc.records[0];
    assert.ok(c.ids.has(sample.id), 'the registry-layer id is the key');
    assert.equal(c.ids.has(sample.export_layer_id), false,
        'the export-layer spelling must NOT be a member of the match set');
    assert.equal(c.ids.has(sample.tail), false, 'the bare tail must not be a member either');
});
