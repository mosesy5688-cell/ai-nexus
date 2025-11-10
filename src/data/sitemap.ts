import models from '../../public/models.json';

export const staticPages = [
    { url: '/', title: 'Home' },
    { url: '/about', title: 'About Us' },
    { url: '/compliance', title: 'Compliance' },
];

export const keywordPages = [
  { slug: 'stable-diffusion', title: 'Top Free AI Tools for Stable Diffusion' },
  { slug: 'image-generation', title: 'Top Free AI Tools for Image Generation' },
];

export const modelPages = models.map(model => ({
    url: `/model/${model.id.replace(/\//g, '--')}`,
    name: model.name
}));