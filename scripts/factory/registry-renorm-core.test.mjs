// OP-GR-B (ruling D-2026-0810-418): cohort reconciliation + governed transform.
//
// PURE. No R2, no filesystem, no key, no network. What this suite defends:
//   - the transform delegates to the PRODUCER's own applyFieldContracts, so the
//     repaired stock and the live producer cannot drift apart;
//   - "only `tags` and its five disclosure stamps may move" is enforced, not
//     merely intended -- a transform that touches anything else is reported
//     ungoverned and drives the whole operation to self-abandon;
//   - reconciliation against the census is one-for-one in BOTH directions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    GIANT_MIN_BYTES, ALLOWED_DELTA_FIELDS, RECONCILE, CENSUS_LAYER,
    loadCensus, fieldDelta, deltaIsGoverned, transformRecord,
    reconcile, accounting, verifyOutcome,
} from './lib/registry-renorm-core.js';
import { PRODUCER_LINE_MAX_BYTES } from '../ingestion/lib/field-contracts.js';

const dto = (i) => ({
    ref: `t${i}`, name: `tag-${i}`, nameNullable: `tag-${i}`, hasName: true,
    description: `d${i}`, hasDescription: true, fullPath: `p/t${i}`, hasFullPath: true,
    competitionCount: 0, datasetCount: 0, scriptCount: 0, totalCount: 0,
});
const kaggleRecord = (id, tagCount) => ({
    id, source: 'kaggle', type: 'dataset', name: 'n', status: 'active',
    tags: Array.from({ length: tagCount }, (_, i) => dto(i)),
});
const census = (ids) => loadCensus({
    count: ids.length, forensics_sha256: 'x', matches_layer: CENSUS_LAYER,
    records: ids.map((id) => ({ id })),
});

test('C0 the giant bound IS the producer bound (no second constant exists)', () => {
    assert.equal(GIANT_MIN_BYTES, PRODUCER_LINE_MAX_BYTES);
    assert.equal(GIANT_MIN_BYTES, 32 * 1024 * 1024);
});

test('C0b the governed field set is exactly tags + the five disclosure stamps', () => {
    assert.deepEqual([...ALLOWED_DELTA_FIELDS].sort(), [
        'tags', 'tags_kept_count', 'tags_original_count',
        'tags_policy', 'tags_projected', 'tags_truncated',
    ]);
});

test('C1 loadCensus rejects an empty, mis-counted or duplicated census', () => {
    const L = { matches_layer: CENSUS_LAYER };
    assert.throws(() => loadCensus({ ...L, count: 0, records: [] }), /OP_GR_B_CENSUS_EMPTY/);
    assert.throws(() => loadCensus({ ...L, count: 9, records: [{ id: 'a' }] }), /OP_GR_B_CENSUS_COUNT_DRIFT/);
    assert.throws(() => loadCensus({ ...L, count: 2, records: [{ id: 'a' }, { id: 'a' }] }), /OP_GR_B_CENSUS_DUPLICATE_ID/);
    assert.throws(() => loadCensus({ ...L, count: 1, records: [{ census_bytes: 1 }] }), /OP_GR_B_CENSUS_ROW_WITHOUT_ID/);
});

test('C2 transformRecord projects tags and stamps exactly the five disclosures', () => {
    const text = JSON.stringify(kaggleRecord('kaggle-dataset--a--b', 500));
    const { governed, row, afterText } = transformRecord(text);

    assert.equal(governed, true);
    const after = JSON.parse(afterText);
    assert.ok(Array.isArray(after.tags));
    assert.equal(after.tags.length, 64, 'the producer contract caps tags at 64 elements');
    assert.ok(after.tags.every((t) => typeof t === 'string'), 'every kept element must be a NAME STRING');
    assert.equal(after.tags[0], 'tag-0');
    assert.equal(after.tags_original_count, 500);
    assert.equal(after.tags_kept_count, 64);
    assert.equal(after.tags_policy, 'kaggle/tags/list-cap/1');
    assert.equal(after.tags_truncated, true);
    assert.equal(after.tags_projected, 'kaggle-tag-dto-name/1');
    assert.ok(row.after_bytes < row.before_bytes);
    assert.equal(row.bytes_reclaimed, row.before_bytes - row.after_bytes);
    assert.deepEqual(row.fields_changed, [...ALLOWED_DELTA_FIELDS].sort());
});

test('C3 every non-governed field survives the transform untouched', () => {
    const rec = kaggleRecord('kaggle-dataset--a--c', 200);
    rec.description = 'unchanged';
    rec.meta_json = '{"k":1}';
    rec.fni_score = 12.5;
    rec._last_seen = '2026-02-08T06:39:07.001Z';
    const before = JSON.parse(JSON.stringify(rec));
    const { afterText } = transformRecord(JSON.stringify(rec));
    const after = JSON.parse(afterText);

    for (const k of Object.keys(before)) {
        if (k === 'tags') continue;
        assert.deepEqual(after[k], before[k], `${k} must not move`);
    }
    assert.equal(Object.keys(after).length, Object.keys(before).length + 5,
        'exactly the five disclosure stamps may be added');
});

test('C4 a record NOT under contract is left completely alone', () => {
    // No kaggle:<type> contract entry -> nothing applies -> nothing is stamped.
    const text = JSON.stringify({ id: 'hf-model--x--y', source: 'huggingface', type: 'model', tags: [dto(1), dto(2)] });
    const { governed, row, afterText } = transformRecord(text);
    assert.equal(governed, true, 'a no-op is governed: it changed nothing');
    assert.deepEqual(row.fields_changed, []);
    assert.equal(JSON.parse(afterText).tags_policy, undefined, 'an untouched record must gain NO disclosure field');
});

test('C5 fieldDelta / deltaIsGoverned catch an out-of-contract change', () => {
    const before = new Map(Object.entries({ id: 'a', name: 'n', tags: [] }));
    assert.equal(deltaIsGoverned(fieldDelta(before, { id: 'a', name: 'n', tags: ['x'] })), true);
    assert.equal(deltaIsGoverned(fieldDelta(before, { id: 'a', name: 'CHANGED', tags: [] })), false);
    assert.equal(deltaIsGoverned(fieldDelta(before, { id: 'a', name: 'n', tags: [], extra: 1 })), false);
    assert.equal(deltaIsGoverned(fieldDelta(before, { id: 'a', tags: [] })), false, 'a removal is never governed');
});

test('C6 reconcile is one-for-one in BOTH directions', () => {
    const rows = [{ id: 'a', governed: true }, { id: 'b', governed: true }];
    assert.equal(reconcile(rows, census(['a', 'b'])).status, RECONCILE.MATCH);

    const missing = reconcile([{ id: 'a', governed: true }], census(['a', 'b']));
    assert.equal(missing.status, RECONCILE.MISMATCH);
    assert.deepEqual(missing.missing, ['b']);

    const extra = reconcile(rows, census(['a']));
    assert.equal(extra.status, RECONCILE.MISMATCH);
    assert.deepEqual(extra.extra, ['b']);
});

test('C7 an ungoverned record alone is enough to force MISMATCH', () => {
    const rows = [{ id: 'a', governed: true }, { id: 'b', governed: false, fields_changed: ['name'], fields_removed: [] }];
    const rec = reconcile(rows, census(['a', 'b']));
    assert.equal(rec.status, RECONCILE.MISMATCH);
    assert.equal(rec.missing.length, 0, 'both ids are present -- the failure is the field delta, not the census');
    assert.deepEqual(rec.ungoverned.map((u) => u.id), ['b']);
});

test('C8 a duplicated id among the giants is a MISMATCH, not a silent dedup', () => {
    const rows = [{ id: 'a', governed: true }, { id: 'a', governed: true }];
    assert.equal(reconcile(rows, census(['a'])).status, RECONCILE.MISMATCH);
});

test('C9 accounting totals only governed rows and reports elements dropped', () => {
    const acc = accounting([
        { governed: true, before_bytes: 1000, after_bytes: 100, bytes_reclaimed: 900, tags_original_count: 500, tags_kept_count: 64 },
        { governed: false, before_bytes: 50 },
    ]);
    assert.equal(acc.records, 2);
    assert.equal(acc.governed_records, 1);
    assert.equal(acc.bytes_reclaimed_total, 900);
    assert.equal(acc.tag_elements_dropped_total, 436);
    assert.equal(acc.max_after_bytes, 100);
});

test('C10 verifyOutcome fails on a surviving giant or on record-count drift', () => {
    const ok = verifyOutcome({
        rows: [{ id: 'a', after_bytes: 900 }],
        shards: [{ shard: 'part-000.bin', entity_count_before: 1000, entity_count_after: 1000 }],
    });
    assert.equal(ok.ok, true);

    const stillGiant = verifyOutcome({
        rows: [{ id: 'a', after_bytes: GIANT_MIN_BYTES }],
        shards: [{ shard: 'part-000.bin', entity_count_before: 1000, entity_count_after: 1000 }],
    });
    assert.equal(stillGiant.ok, false);
    assert.deepEqual(stillGiant.giant_records_remaining.map((r) => r.id), ['a']);

    const drift = verifyOutcome({
        rows: [{ id: 'a', after_bytes: 10 }],
        shards: [{ shard: 'part-000.bin', entity_count_before: 1000, entity_count_after: 999 }],
    });
    assert.equal(drift.ok, false, 'losing a record is never an acceptable outcome');
    assert.equal(drift.record_count_drift[0].after, 999);
});
