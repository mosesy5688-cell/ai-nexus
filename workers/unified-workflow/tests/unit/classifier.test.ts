import { describe, it, expect } from 'vitest';
import { assignCategory, estimateSizeBucket } from '../../src/utils/model-enricher';

describe('V6.0 Classifier (model-enricher)', () => {
    it('should classify known pipeline_tag correctly', () => {
        const model = { pipeline_tag: 'text-generation' };
        const result = assignCategory(model);
        expect(result.category).toBe('text-generation');
        expect(result.confidence).toBe('high');
        expect(result.status).toBe('classified');
    });

    it('should classify image-classification correctly', () => {
        const model = { pipeline_tag: 'image-classification' };
        const result = assignCategory(model);
        expect(result.category).toBe('vision-multimedia');
        expect(result.confidence).toBe('high');
    });

    it('should return pending for unknown/missing pipeline_tag', () => {
        const model = { pipeline_tag: null, tags: ['nlp'] };
        const result = assignCategory(model);
        expect(result.category).toBeNull();
        expect(result.confidence).toBe('none');
        expect(result.status).toBe('pending_classification');
    });

    it('should return pending for unmapped pipeline_tag', () => {
        const model = { pipeline_tag: 'weird-tag-xyz' };
        const result = assignCategory(model);
        expect(result.category).toBeNull();
        expect(result.status).toBe('pending_classification');
    });
});

describe('Size Estimator (model-enricher)', () => {
    it('should use safetensors config if available', () => {
        const model = { safetensors: { total: 7000000000 } }; // 7B
        const result = estimateSizeBucket(model);
        expect(result.size_bucket).toBe('7-13B');
        expect(result.size_source).toBe('config');
    });

    it('should infer 7B from name', () => {
        const model = { id: 'mistralai/Mistral-7B-v0.1' };
        const result = estimateSizeBucket(model);
        expect(result.size_bucket).toBe('7-13B');
        expect(result.size_source).toBe('name_inference');
    });

    it('should infer MoE size from name', () => {
        const model = { id: 'mistralai/Mixtral-8x7B-v0.1' };
        const result = estimateSizeBucket(model);
        // 8 * 7 = 56B -> 30-70B bucket
        expect(result.size_bucket).toBe('30-70B');
    });
});
