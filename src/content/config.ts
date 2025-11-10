import { defineCollection, z } from 'astro:content';

const keywordsCollection = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    keyword: z.string(),
  }),
});

export const CORE_KEYWORDS = [
    { slug: 'image-generation', title: 'Image Generation' },
    { slug: 'stable-diffusion', title: 'Stable Diffusion' },
    // Add more core keywords here as your site grows
];

export const collections = {
  'keywords': keywordsCollection,
};