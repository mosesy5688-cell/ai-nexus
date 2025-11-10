import { defineCollection, z } from 'astro:content';

const keywordsCollection = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    keyword: z.string(),
  }),
});

export const CORE_CATEGORIES = [
    { 
        slug: 'image-generation', 
        title: 'AI Image & Art Generation',
        description: 'Models focused on generating high-resolution images, creative art, and realistic photos from text prompts.'
    },
    { 
        slug: 'text-to-speech', 
        title: 'Text-to-Speech (TTS)',
        description: 'Synthetic voice generation for narration, virtual assistants, and accessibility features.'
    },
    { 
        slug: 'code-generation', 
        title: 'Code Synthesis & Programming Helpers',
        description: 'AI tools for generating code snippets, completing functions, or translating between programming languages.'
    },
];

export const collections = {
  'keywords': keywordsCollection,
};