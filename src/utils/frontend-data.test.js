// src/utils/frontend-data.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import {
    normalizeModelData,
    formatMetric,
    prepareCardData,
    generateSlug,
    parseSlug,
    getDisplayName,
    getBestDescription,
    formatRelativeTime,
    validateModelData,
    prepareDetailData,
    findSimilarModels
} from './frontend-data.js';

describe('normalizeModelData', () => {
    describe('Perfect model data', () => {
        it('should normalize a complete model object with all fields', () => {
            const perfectModel = {
                id: 'openai/gpt-4',
                name: 'GPT-4',
                author: 'OpenAI',
                likes: 5000,
                downloads: 1000000,
                description: 'Advanced language model',
                seo_summary: 'GPT-4: State-of-the-art language model',
                seo_status: 'done',
                link_status: 'active',
                pipeline_tag: 'text-generation',
                license: 'MIT',
                last_updated: '2024-01-15T10:30:00.000Z',
                cover_image_url: 'https://example.com/image.png',
                tags: '["ai", "nlp"]',
                links_data: '{"github": "https://github.com/openai"}',
                related_ids: '["model1", "model2"]'
            };

            const result = normalizeModelData(perfectModel);

            expect(result.id).toBe('openai/gpt-4');
            expect(result.name).toBe('GPT-4');
            expect(result.author).toBe('OpenAI');
            expect(result.likes).toBe(5000);
            expect(result.downloads).toBe(1000000);
            expect(result.description).toBe('Advanced language model');
            expect(result.seo_summary).toBe('GPT-4: State-of-the-art language model');
            expect(result.seo_status).toBe('done');
            expect(result.link_status).toBe('active');
            expect(result.pipeline_tag).toBe('text-generation');
            expect(result.license).toBe('MIT');
            expect(result.last_updated).toBe('2024-01-15T10:30:00.000Z');
            expect(result.cover_image_url).toBe('https://example.com/image.png');
            expect(result.tags).toEqual(['ai', 'nlp']);
            expect(result.links_data).toEqual({ github: 'https://github.com/openai' });
            expect(result.related_ids).toEqual(['model1', 'model2']);
        });
    });

    describe('Missing optional fields', () => {
        it('should provide fallbacks for missing optional fields', () => {
            const minimalModel = {
                id: 'test/model',
                name: 'Test Model',
                author: 'Test Author'
            };

            const result = normalizeModelData(minimalModel);

            expect(result.id).toBe('test/model');
            expect(result.name).toBe('Test Model');
            expect(result.author).toBe('Test Author');
            expect(result.likes).toBe(0);
            expect(result.downloads).toBe(0);
            expect(result.description).toBe('');
            expect(result.seo_summary).toBe('');
            expect(result.seo_status).toBe('pending');
            expect(result.link_status).toBe('unknown');
            expect(result.pipeline_tag).toBe('');
            expect(result.license).toBe('Unknown');
            expect(result.cover_image_url).toBe('/placeholder-model.png');
            expect(result.tags).toEqual([]);
            expect(result.links_data).toEqual({});
            expect(result.related_ids).toEqual([]);
        });
    });

    describe('last_updated field logic', () => {
        it('should use last_updated when provided', () => {
            const model = {
                id: 'test/model',
                last_updated: '2024-01-15T10:30:00.000Z'
            };

            const result = normalizeModelData(model);
            expect(result.last_updated).toBe('2024-01-15T10:30:00.000Z');
        });

        it('should fall back to current date when last_updated is missing', () => {
            const model = {
                id: 'test/model'
            };

            const result = normalizeModelData(model);
            const parsedDate = new Date(result.last_updated);
            expect(parsedDate).toBeInstanceOf(Date);
            expect(isNaN(parsedDate.getTime())).toBe(false);
        });

        it('should NOT use lastUpdated field (removed in refactoring)', () => {
            const model = {
                id: 'test/model',
                lastUpdated: '2024-01-01T00:00:00.000Z' // This should be ignored
            };

            const result = normalizeModelData(model);
            // Should fallback to current date, NOT use lastUpdated
            expect(result.last_updated).not.toBe('2024-01-01T00:00:00.000Z');
            const parsedDate = new Date(result.last_updated);
            expect(parsedDate).toBeInstanceOf(Date);
        });
    });

    describe('Null/undefined model handling', () => {
        it('should return placeholder for null model', () => {
            const result = normalizeModelData(null);

            expect(result.id).toBe('placeholder');
            expect(result.name).toBe('Model Unavailable');
            expect(result.author).toBe('Unknown');
            expect(result.description).toContain('currently unavailable');
            expect(result._isPlaceholder).toBe(true);
        });

        it('should return placeholder for undefined model', () => {
            const result = normalizeModelData(undefined);

            expect(result.id).toBe('placeholder');
            expect(result._isPlaceholder).toBe(true);
        });

        it('should return placeholder for non-object model', () => {
            const result = normalizeModelData('not an object');

            expect(result.id).toBe('placeholder');
            expect(result._isPlaceholder).toBe(true);
        });
    });

    describe('Image URL validation', () => {
        it('should accept absolute HTTPS URLs', () => {
            const model = {
                id: 'test/model',
                cover_image_url: 'https://example.com/image.png'
            };

            const result = normalizeModelData(model);
            expect(result.cover_image_url).toBe('https://example.com/image.png');
        });

        it('should accept absolute path starting with /', () => {
            const model = {
                id: 'test/model',
                cover_image_url: '/images/model.png'
            };

            const result = normalizeModelData(model);
            expect(result.cover_image_url).toBe('/images/model.png');
        });

        it('should accept relative path starting with ./', () => {
            const model = {
                id: 'test/model',
                cover_image_url: './images/model.png'
            };

            const result = normalizeModelData(model);
            expect(result.cover_image_url).toBe('./images/model.png');
        });

        it('should accept relative path starting with ../', () => {
            const model = {
                id: 'test/model',
                cover_image_url: '../images/model.png'
            };

            const result = normalizeModelData(model);
            expect(result.cover_image_url).toBe('../images/model.png');
        });

        it('should fallback to placeholder for invalid URLs', () => {
            const model = {
                id: 'test/model',
                cover_image_url: 'not-a-valid-url'
            };

            const result = normalizeModelData(model);
            expect(result.cover_image_url).toBe('/placeholder-model.png');
        });

        it('should fallback to placeholder for missing URL', () => {
            const model = {
                id: 'test/model'
            };

            const result = normalizeModelData(model);
            expect(result.cover_image_url).toBe('/placeholder-model.png');
        });
    });
});

describe('formatMetric', () => {
    it('should return number as string for values under 1000', () => {
        expect(formatMetric(0)).toBe('0');
        expect(formatMetric(1)).toBe('1');
        expect(formatMetric(999)).toBe('999');
    });

    it('should format thousands with K suffix', () => {
        expect(formatMetric(1000)).toBe('1.0K');
        expect(formatMetric(1500)).toBe('1.5K');
        expect(formatMetric(25000)).toBe('25.0K');
        expect(formatMetric(999999)).toBe('1000.0K');
    });

    it('should format millions with M suffix', () => {
        expect(formatMetric(1000000)).toBe('1.0M');
        expect(formatMetric(1230000)).toBe('1.2M');
        expect(formatMetric(15600000)).toBe('15.6M');
        expect(formatMetric(1000000000)).toBe('1000.0M');
    });

    it('should handle non-numeric inputs', () => {
        expect(formatMetric('1500')).toBe('1.5K');
        expect(formatMetric('not a number')).toBe('0');
        expect(formatMetric(null)).toBe('0');
        expect(formatMetric(undefined)).toBe('0');
    });

    it('should handle zero', () => {
        expect(formatMetric(0)).toBe('0');
    });
});

describe('prepareCardData', () => {
    it('should correctly transform normalized model into card structure', () => {
        const model = {
            id: 'openai/gpt-4',
            name: 'GPT-4',
            author: 'OpenAI',
            description: 'A very long description that should be truncated to 150 characters maximum. This text continues beyond the limit to test the substring logic properly and ensure it works as expected.',
            likes: 5000,
            downloads: 1500000,
            cover_image_url: 'https://example.com/image.png',
            pipeline_tag: 'text-generation',
            last_updated: '2024-01-15T10:30:00.000Z',
            seo_status: 'pending',
            seo_summary: ''
        };

        const result = prepareCardData(model);

        expect(result.id).toBe('openai/gpt-4');
        expect(result.name).toBe('GPT-4');
        expect(result.author).toBe('OpenAI');
        expect(result.description).toHaveLength(153); // 150 + '...'
        expect(result.description.endsWith('...')).toBe(true);
        expect(result.likes).toBe(5000);
        expect(result.downloads).toBe(1500000);
        expect(result.cover_image_url).toBe('https://example.com/image.png');
        expect(result.url).toBe('/model/openai--gpt-4');
        expect(result.pipeline_tag).toBe('text-generation');
        expect(typeof result.last_updated).toBe('string');
    });

    it('should generate correct URL slug with double dashes', () => {
        const model = {
            id: 'huggingface/bert-base-uncased',
            name: 'BERT Base'
        };

        const result = prepareCardData(model);
        expect(result.url).toBe('/model/huggingface--bert-base-uncased');
    });
});

describe('generateSlug', () => {
    it('should convert forward slashes to double dashes', () => {
        expect(generateSlug('openai/gpt-4')).toBe('openai--gpt-4');
        expect(generateSlug('huggingface/bert-base-uncased')).toBe('huggingface--bert-base-uncased');
    });

    it('should handle multiple slashes', () => {
        expect(generateSlug('org/team/model')).toBe('org--team--model');
    });

    it('should return "unknown" for invalid inputs', () => {
        expect(generateSlug(null)).toBe('unknown');
        expect(generateSlug(undefined)).toBe('unknown');
        expect(generateSlug('')).toBe('unknown');
        expect(generateSlug(123)).toBe('unknown');
    });
});

describe('parseSlug', () => {
    it('should convert double dashes back to forward slashes', () => {
        expect(parseSlug('openai--gpt-4')).toBe('openai/gpt-4');
        expect(parseSlug('huggingface--bert-base-uncased')).toBe('huggingface/bert-base-uncased');
    });

    it('should handle multiple double dashes', () => {
        expect(parseSlug('org--team--model')).toBe('org/team/model');
    });

    it('should return empty string for invalid inputs', () => {
        expect(parseSlug(null)).toBe('');
        expect(parseSlug(undefined)).toBe('');
        expect(parseSlug('')).toBe('');
    });
});

describe('getDisplayName', () => {
    it('should return model name when available', () => {
        const model = { id: 'test/model', name: 'Test Model' };
        expect(getDisplayName(model)).toBe('Test Model');
    });

    it('should fallback to id when name is missing', () => {
        const model = { id: 'test/model' };
        expect(getDisplayName(model)).toBe('test/model');
    });

    it('should return "Untitled" when both name and id are missing', () => {
        const model = {};
        expect(getDisplayName(model)).toBe('Untitled');
    });

    it('should return "Unknown Model" for null/undefined', () => {
        expect(getDisplayName(null)).toBe('Unknown Model');
        expect(getDisplayName(undefined)).toBe('Unknown Model');
    });
});

describe('getBestDescription', () => {
    it('should prefer SEO summary when status is done', () => {
        const model = {
            seo_status: 'done',
            seo_summary: 'SEO optimized description',
            description: 'Regular description'
        };
        expect(getBestDescription(model)).toBe('SEO optimized description');
    });

    it('should fallback to description when SEO status is pending', () => {
        const model = {
            seo_status: 'pending',
            seo_summary: 'SEO optimized description',
            description: 'Regular description'
        };
        expect(getBestDescription(model)).toBe('Regular description');
    });

    it('should clean HTML tags from description', () => {
        const model = {
            description: '<p>This is <strong>bold</strong> text</p>'
        };
        expect(getBestDescription(model)).toBe('This is bold text');
    });

    it('should return fallback message when no description available', () => {
        const model = {};
        expect(getBestDescription(model)).toBe('No description available.');
    });

    it('should return fallback for null/undefined', () => {
        expect(getBestDescription(null)).toBe('No description available.');
        expect(getBestDescription(undefined)).toBe('No description available.');
    });
});

describe('validateModelData', () => {
    it('should return empty array for valid model', () => {
        const validModel = {
            id: 'test/model',
            name: 'Test Model',
            author: 'Test Author',
            description: 'Valid description',
            likes: 100,
            downloads: 1000
        };
        const issues = validateModelData(validModel);
        expect(issues).toEqual([]);
    });

    it('should detect missing id', () => {
        const model = { name: 'Test' };
        const issues = validateModelData(model);
        expect(issues).toContain('missing_id');
    });

    it('should detect missing name', () => {
        const model = { id: 'test/model' };
        const issues = validateModelData(model);
        expect(issues).toContain('missing_name');
    });

    it('should detect invalid description type', () => {
        const model = {
            id: 'test/model',
            name: 'Test',
            author: 'Author',
            description: 123 // Invalid type
        };
        const issues = validateModelData(model);
        expect(issues).toContain('invalid_description');
    });

    it('should detect multiple issues', () => {
        const model = { description: 'test' };
        const issues = validateModelData(model);
        expect(issues.length).toBeGreaterThan(0);
        expect(issues).toContain('missing_id');
        expect(issues).toContain('missing_name');
    });
});

describe('formatRelativeTime', () => {
    it('should return "just now" for very recent times', () => {
        const now = new Date();
        expect(formatRelativeTime(now.toISOString())).toBe('just now');
    });

    it('should format minutes correctly', () => {
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        expect(formatRelativeTime(fiveMinutesAgo.toISOString())).toBe('5m ago');
    });

    it('should format hours correctly', () => {
        const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
        expect(formatRelativeTime(threeHoursAgo.toISOString())).toBe('3h ago');
    });

    it('should format days correctly', () => {
        const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
        expect(formatRelativeTime(twoDaysAgo.toISOString())).toBe('2d ago');
    });

    it('should return "Unknown" for invalid date strings', () => {
        expect(formatRelativeTime('not a date')).toBe('Unknown');
        expect(formatRelativeTime(null)).toBe('Unknown');
        expect(formatRelativeTime(undefined)).toBe('Unknown');
    });
});

describe('findSimilarModels', () => {
    const mockModels = [
        { id: '1', tags: ['ai', 'nlp'] },
        { id: '2', tags: ['ai', 'vision'] },
        { id: '3', tags: ['nlp'] },
        { id: '4', tags: [] },
        { id: 'target', tags: ['ai', 'nlp', 'vision'] }
    ];

    it('should return models sorted by shared tag count', () => {
        const target = { id: 'target', tags: ['ai', 'nlp', 'vision'] };
        const result = findSimilarModels(target, mockModels);

        // Model 1: 2 shared (ai, nlp)
        // Model 2: 2 shared (ai, vision)
        // Model 3: 1 shared (nlp)
        // Model 4: 0 shared (filtered out)

        expect(result.length).toBe(3);
        expect(result[0].id).toMatch(/1|2/);
        expect(result[1].id).toMatch(/1|2/);
        expect(result[2].id).toBe('3');
    });

    it('should exclude the target model itself', () => {
        const target = { id: 'target', tags: ['ai'] };
        const result = findSimilarModels(target, mockModels);
        const ids = result.map(m => m.id);
        expect(ids).not.toContain('target');
    });

    it('should respect the count limit', () => {
        const target = { id: 'target', tags: ['ai'] };
        const result = findSimilarModels(target, mockModels, 2);
        expect(result.length).toBe(2);
    });

    it('should handle empty or no tags gracefully', () => {
        const target = { id: 'target', tags: [] };
        const result = findSimilarModels(target, mockModels);
        expect(result).toEqual([]);
    });
});

describe('prepareDetailData', () => {
    it('should include all normalized fields plus computed fields', () => {
        const model = {
            id: 'test/model',
            name: 'Test Model',
            author: 'Test Author',
            likes: 5000,
            downloads: 1500000,
            description: 'Test description',
            last_updated: '2024-01-15T10:30:00.000Z'
        };

        const result = prepareDetailData(model, []);

        expect(result.id).toBe('test/model');
        expect(result.name).toBe('Test Model');
        expect(result.displayName).toBe('Test Model');
        expect(result.displayDescription).toBe('Test description');
        expect(result.formattedLikes).toBe('5.0K');
        expect(result.formattedDownloads).toBe('1.5M');
        expect(typeof result.relativeTime).toBe('string');
        expect(Array.isArray(result.validation)).toBe(true);
        expect(typeof result.hasIssues).toBe('boolean');
        expect(Array.isArray(result.similarModels)).toBe(true);
    });

    it('should include similar models when allModels is provided', () => {
        const model = { id: 'target', tags: ['ai'] };
        const allModels = [
            { id: '1', tags: ['ai'] },
            { id: '2', tags: ['other'] }
        ];

        const result = prepareDetailData(model, allModels);
        expect(result.similarModels).toHaveLength(1);
        expect(result.similarModels[0].id).toBe('1');
    });

    it('should correctly flag models with validation issues', () => {
        const invalidModel = {
            description: 123 // Invalid type, missing required fields
        };

        const result = prepareDetailData(invalidModel);

        expect(result.hasIssues).toBe(true);
        expect(result.validation.length).toBeGreaterThan(0);
        expect(result.validation).toContain('missing_id');
        expect(result.validation).toContain('missing_name');
    });
});