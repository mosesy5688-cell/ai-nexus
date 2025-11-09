// src/content/config.ts
import { defineCollection } from 'astro:content';

// Defines the structure for a single keyword link item
interface Keyword {
  slug: string;
  title: string;
  description: string;
  matchTerms: string[]; // New property for flexible matching
  subKeywords?: Keyword[];
}

/**
 * The core list of keywords that will appear on the homepage (src/pages/index.astro).
 * This list defines the main categories users can navigate into.
 */
export const CORE_KEYWORDS: Keyword[] = [
  {
    slug: 'ai-image-generation',
    title: 'AI Image & Art Generation',
    description: 'Models focused on generating high-resolution images, creative art, and realistic photos from text prompts (e.g., Stable Diffusion, Midjourney alternatives).',
    matchTerms: ['text-to-image', 'image-generation', 'image-to-image', 'stable-diffusion'],
    subKeywords: [
      {
        slug: 'face-swapping',
        title: 'Face Swapping & Deepfakes',
        description: 'Models dedicated to changing faces in images or videos for entertainment or research purposes.',
        matchTerms: ['face-swapping', 'deepfake', 'image-to-image'],
      }
    ]
  },
  {
    slug: 'large-language-models',
    title: 'Large Language Models (LLMs)',
    description: 'Generative models for text, code completion, summarization, and complex reasoning (e.g., Llama, Mistral, Gemma).',
    matchTerms: ['text-generation', 'conversational', 'text2text-generation'],
    subKeywords: [
      {
        slug: 'code-generation',
        title: 'Code Synthesis & Programming Helpers',
        description: 'AI tools for generating code snippets, completing functions, or translating between programming languages.',
        matchTerms: ['code-generation', 'code-completion'],
      },
      {
        slug: 'machine-translation',
        title: 'Machine Translation',
        description: 'High-quality models for automated language translation between various dialects (e.g., NLLB).',
        matchTerms: ['translation'],
      }
    ]
  },
  {
    slug: 'speech-to-text',
    title: 'Speech Recognition & ASR',
    description: 'Tools for converting spoken language into text, essential for transcription and voice command interfaces (e.g., Whisper).',
    matchTerms: ['automatic-speech-recognition', 'speech-recognition'],
  },
  {
    slug: 'text-to-speech',
    title: 'Text-to-Speech (TTS)',
    description: 'Synthetic voice generation for narration, virtual assistants, and accessibility features.',
    matchTerms: ['text-to-speech', 'text-to-audio'],
  },
  {
    slug: 'video-generation',
    title: 'Video & Animation Generation',
    description: 'Models that create dynamic video clips, animated sequences, or motion from text or images.',
    matchTerms: ['video-generation', 'image-to-video', 'text-to-video'],
  },
  {
    slug: 'reinforcement-learning',
    title: 'Reinforcement Learning (RL)',
    description: 'Models focused on training agents to make sequential decisions in dynamic environments (e.g., AlphaZero methods).',
    matchTerms: ['reinforcement-learning', 'robotics'],
    subKeywords: [
      {
        slug: 'ai-audio-tools',
        title: 'AI Audio & Speech Tools',
        description: 'A suite of models for processing, generating, and understanding audio and speech.',
        matchTerms: ['audio', 'speech'],
      }
    ]
  },
];

// Content collections definitions (currently empty, but required by Astro's content system)
export const collections = {
    // You can define content collections here if you use MDX/Markdown content files.
    // Example: 'posts': defineCollection({ /* schema */ }),
};
