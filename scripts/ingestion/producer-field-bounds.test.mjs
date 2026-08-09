// FINDING-GR-1 / D-2026-0809-416 SS1 (a)+(c): producer-side field contract at the
// Kaggle adapter normalisation boundary.
//
// HERMETIC: the defect fixture is SYNTHESISED in-process (no real record content,
// no network, no credentials, no R2). It reproduces only the SHAPE that forensics
// v1 measured: a Kaggle Swagger Tag-DTO array (14 flat keys per element) attached
// to one dataset entity at a cardinality no real dataset has.
//
// NON-VACUITY: every assertion below is RED against the pre-fix code path (the
// adapter that assigned `tags: dataset.tags || []` and computed content_hash over
// it). Reverting the two applyFieldContracts() calls in kaggle-adapter.js turns
// T1/T2/T3/T4 red; removing the disclosure stamp alone turns T2/T4 red; removing
// the counter increments alone turns T3/T4 red.
import test from 'node:test';
import assert from 'node:assert/strict';
import KaggleAdapter from './adapters/kaggle-adapter.js';
import {
    applyFieldContracts, projectListField, createCounters, resetCounters, getCounters,
} from './lib/field-contract-enforcer.js';
import { FIELD_CONTRACTS, PROJECTION } from './lib/field-contracts.js';

const DTO_KEYS = [
    'ref', 'name', 'nameNullable', 'hasName', 'description', 'hasDescription',
    'descriptionNullable', 'fullPath', 'fullPathNullable', 'hasFullPath',
    'competitionCount', 'datasetCount', 'scriptCount', 'totalCount',
];

/** Synthesise ONE Kaggle Tag-DTO element (shape only; values are generated). */
function tagDto(i) {
    const el = {};
    for (const k of DTO_KEYS) {
        if (k.startsWith('has')) el[k] = true;
        else if (k.endsWith('Count')) el[k] = i;
        else el[k] = `${k}-${i}`;
    }
    return el;
}

/** Synthetic RAW Kaggle dataset carrying an unbounded Tag-DTO array. */
function rawDataset(tagCount) {
    return {
        _entityType: 'dataset',
        ref: 'synthetic-owner/synthetic-dataset',
        title: 'synthetic dataset',
        ownerRef: 'synthetic-owner',
        subtitle: 'synthetic subtitle',
        description: 'synthetic body',
        licenseName: 'CC0-1.0',
        tags: Array.from({ length: tagCount }, (_, i) => tagDto(i)),
    };
}

const CONTRACT = FIELD_CONTRACTS['kaggle:dataset'].tags;
const GIANT = 200000;

test('T1 defect fixture: unbounded Tag-DTO array is bounded at the adapter boundary', () => {
    resetCounters();
    const entity = new KaggleAdapter().normalize(rawDataset(GIANT));

    assert.equal(Array.isArray(entity.tags), true);
    assert.ok(entity.tags.length <= CONTRACT.maxElements,
        `tags cardinality ${entity.tags.length} > cap ${CONTRACT.maxElements}`);
    assert.equal(entity.tags.every((t) => typeof t === 'string'), true,
        'every kept tag must be a projected NAME string, never a DTO object');
    const tagBytes = Buffer.byteLength(JSON.stringify(entity.tags), 'utf8');
    assert.ok(tagBytes <= CONTRACT.maxBytes + entity.tags.length + 2,
        `serialised tags ${tagBytes} B exceeds the declared byte cap`);
});

test('T2 disclosure: truncation is stamped on the record, never silent', () => {
    resetCounters();
    const entity = new KaggleAdapter().normalize(rawDataset(GIANT));

    assert.equal(entity.tags_truncated, true);
    assert.equal(entity.tags_original_count, GIANT);
    assert.equal(entity.tags_kept_count, entity.tags.length);
    assert.equal(entity.tags_projected, PROJECTION.KAGGLE_TAG_DTO_NAME);
    assert.equal(entity.tags_policy, CONTRACT.policy);
});

test('T3 disclosure: truncation is counted', () => {
    const state = resetCounters();
    new KaggleAdapter().normalize(rawDataset(GIANT));

    assert.equal(state, getCounters());
    assert.equal(state.records_contract_examined, 1);
    assert.equal(state.records_field_truncated, 1);
    assert.equal(state.records_field_projected, 1);
    assert.equal(state.fields_truncated, 1);
    assert.equal(state.elements_dropped, GIANT - CONTRACT.maxElements);
});

test('T4 MUTATION ANCHOR: any shrink of tags implies BOTH a marker AND a counter', () => {
    // The disclosure contract expressed as a property, so that turning
    // "truncate + disclose" into "truncate silently" cannot pass this suite.
    const state = resetCounters();
    const raw = rawDataset(GIANT);
    const before = raw.tags.length;
    const entity = new KaggleAdapter().normalize(raw);
    const after = entity.tags.length;

    assert.ok(after < before, 'fixture must actually shrink, otherwise this test is vacuous');
    assert.equal(entity.tags_truncated, true, 'shrunk field MUST carry the truncation marker');
    assert.equal(entity.tags_original_count, before, 'marker MUST carry the true original count');
    assert.ok(state.elements_dropped > 0, 'shrunk field MUST increment the published counter');
    assert.equal(state.elements_dropped, before - after);
});

test('T5 conforming record: untouched, unstamped, uncounted', () => {
    const state = resetCounters();
    const raw = rawDataset(0);
    raw.tags = ['nlp', 'finance', 'timeseries'];
    const entity = new KaggleAdapter().normalize(raw);

    assert.deepEqual(entity.tags, ['nlp', 'finance', 'timeseries']);
    assert.equal('tags_truncated' in entity, false);
    assert.equal('tags_policy' in entity, false);
    assert.equal(state.records_field_truncated, 0);
    assert.equal(state.elements_dropped, 0);
});

test('T6 idempotent: re-applying the contract neither re-stamps nor double-counts', () => {
    const state = resetCounters();
    const entity = new KaggleAdapter().normalize(rawDataset(GIANT));
    const firstTags = [...entity.tags];
    const dropped = state.elements_dropped;

    applyFieldContracts(entity, state);

    // Element-wise, NOT deepEqual: against the pre-fix code path `entity.tags`
    // is a 200k-element DTO array and node:assert would spend minutes rendering
    // a diff. A red test must be cheap to be a usable gate.
    assert.equal(entity.tags.length, firstTags.length);
    assert.equal(entity.tags.every((t, i) => t === firstTags[i]), true);
    assert.equal(entity.tags_original_count, GIANT, 'a re-run must not rewrite the original count');
    assert.equal(state.elements_dropped, dropped);
    assert.equal(state.records_field_truncated, 1);
});

test('T7 a source with no contract entry is left alone', () => {
    const state = resetCounters();
    const record = { id: 'x', source: 'huggingface', type: 'model', tags: [1, 2, 3] };
    const out = applyFieldContracts(record, state);

    assert.deepEqual(out.applied, []);
    assert.deepEqual(record.tags, [1, 2, 3]);
    assert.equal(state.fields_truncated, 0);
});

test('T8 SOLE INPUT: the table drives the bounds, not the enforcer', () => {
    const table = {
        'kaggle:dataset': {
            tags: { ...CONTRACT, maxElements: 2, maxBytes: 1024 },
        },
    };
    const state = createCounters();
    const record = { id: 'x', source: 'kaggle', type: 'dataset', tags: [tagDto(1), tagDto(2), tagDto(3)] };

    applyFieldContracts(record, state, table);

    assert.equal(record.tags.length, 2, 'a different table MUST produce a different bound');
    assert.equal(record.tags_original_count, 3);
});

test('T9 projection prefers name, falls back through the declared key order', () => {
    const el = { ref: 'owner/ref-only', hasName: false };
    const r = projectListField([{ name: 'first-choice' }, el, { nothing: 1 }], CONTRACT);

    assert.deepEqual(r.kept, ['first-choice', 'owner/ref-only']);
    assert.equal(r.original, 3);
    assert.equal(r.truncated, true, 'an unusable element that is dropped is a truncation');
    assert.equal(r.projected, true);
});

test('T10 per-element byte clamp is applied and disclosed as a projection', () => {
    const r = projectListField(['x'.repeat(CONTRACT.maxElementBytes + 50)], CONTRACT);

    assert.equal(Buffer.byteLength(r.kept[0], 'utf8'), CONTRACT.maxElementBytes);
    assert.equal(r.projected, true);
});
