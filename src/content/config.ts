export const CORE_KEYWORDS = [
    {
        slug: 'ai-image-generation',
        title: 'AI Image Generation',
        faqs: [
            {
                question: 'What is AI Image Generation?',
                answer: 'AI image generation is the process of creating images from textual descriptions using artificial intelligence models, such as DALL-E, Midjourney, and Stable Diffusion.'
            },
            {
                question: 'How do AI image generators work?',
                answer: 'They typically use a process called diffusion, where a model learns to reverse a process of adding noise to an image. By starting with random noise and a text prompt, the model can "denoise" it into a coherent image that matches the description.'
            }
        ]
    },
    // ... (rest of the code) ...
];

export type CoreKeyword = typeof CORE_KEYWORDS[0];