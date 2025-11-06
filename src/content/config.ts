// src/content/config.ts
import { defineCollection } from 'astro:content';

// Defines the structure for a single keyword link item
interface Keyword {
  slug: string;
  title: string;
  description: string;
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
  },
  {
    slug: 'large-language-models',
    title: 'Large Language Models (LLMs)',
    description: 'Generative models for text, code completion, summarization, and complex reasoning (e.g., Llama, Mistral, Gemma).',
  },
  {
    slug: 'speech-to-text',
    title: 'Speech Recognition & ASR',
    description: 'Tools for converting spoken language into text, essential for transcription and voice command interfaces (e.g., Whisper, OpenVoice).',
  },
  {
    slug: 'text-to-speech',
    title: 'Text-to-Speech (TTS)',
    description: 'Synthetic voice generation for narration, virtual assistants, and accessibility features.',
  },
  {
    slug: 'video-generation',
    title: 'Video & Animation Generation',
    description: 'Models that create dynamic video clips, animated sequences, or motion from text or images.',
  },
  {
    slug: 'code-generation',
    title: 'Code Synthesis & Programming Helpers',
    description: 'AI tools for generating code snippets, completing functions, or translating between programming languages (e.g., Code Llama, GitHub Copilot alternatives).',
  },
  {
    slug: 'face-swapping',
    title: 'Face Swapping & Deepfakes',
    description: 'Models dedicated to changing faces in images or videos for entertainment or research purposes.',
  },
  {
    slug: 'machine-translation',
    title: 'Machine Translation',
    description: 'High-quality models for automated language translation between various dialects (e.g., NLLB).',
  },
  {
    slug: 'reinforcement-learning',
    title: 'Reinforcement Learning (RL)',
    description: 'Models focused on training agents to make sequential decisions in dynamic environments (e.g., AlphaZero methods).',
  },
];

// Content collections definitions (currently empty, but required by Astro's content system)
export const collections = {
    // You can define content collections here if you use MDX/Markdown content files.
    // Example: 'posts': defineCollection({ /* schema */ }),
};
