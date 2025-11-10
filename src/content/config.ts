import { defineCollection, z } from 'astro:content';

const keywordsCollection = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    keyword: z.string(),
  }),
});

export const collections = {
  'keywords': keywordsCollection,
};