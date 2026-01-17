// src/data/knowledge-articles.ts
import { article as mmlu } from './knowledge/what-is-mmlu';
import { article as humaneval } from './knowledge/what-is-humaneval';
import { article as context } from './knowledge/what-is-context-length';
import { article as fni } from './knowledge/what-is-fni';
import { article as deploy } from './knowledge/what-is-deploy-score';
import { article as gguf } from './knowledge/what-is-gguf';

export interface KnowledgeArticle {
  title: string;
  description: string;
  category: string;
  content: string;
  difficulty?: 'Beginner' | 'Intermediate' | 'Advanced';
  effort?: string;
}

// Helper for stubs
const createStub = (title: string, desc: string, cat: string) => ({
  title,
  description: desc,
  category: cat,
  content: `## Quick Overview\n\n${desc}\n\nThis article is currently being updated with the latest AI research and technical specifications. Check back soon for the full deep dive!\n\n---\n\n### Related Concepts\n- [Transformer Architecture](/knowledge/transformer)\n- [MMLU Benchmark](/knowledge/mmlu)\n- [FNI Score](/knowledge/fni)`
});

export const articles: Record<string, KnowledgeArticle> = {
  // Full slugs (Existing)
  'what-is-mmlu': mmlu,
  'what-is-humaneval': humaneval,
  'what-is-context-length': context,
  'what-is-fni': fni,
  'what-is-deploy-score': deploy,
  'what-is-gguf': gguf,

  // Stubs for remaining articles (V15.5 connectivity)
  'what-is-hellaswag': createStub('What is HellaSwag?', 'Commonsense reasoning benchmark for LLMs', 'benchmarks'),
  'what-is-arc': createStub('What is ARC?', 'AI2 Reasoning Challenge for science questions', 'benchmarks'),
  'what-is-parameters': createStub('What are Model Parameters?', 'Understanding 7B, 70B and model scale', 'architecture'),
  'what-is-transformer': createStub('What is a Transformer?', 'The architecture behind modern LLMs', 'architecture'),
  'llama-family-guide': createStub('Llama Family Guide', "Meta's open weights model series", 'model-families'),
  'qwen-family-guide': createStub('Qwen Family Guide', "Alibaba's efficient LLM series", 'model-families'),
  'mistral-family-guide': createStub('Mistral Family Guide', "Mistral AI's high-performance models", 'model-families'),
  'how-to-run-locally': createStub('How to Run LLMs Locally', 'Running AI models on consumer hardware', 'deployment'),
  'what-is-ollama': createStub('What is Ollama?', 'Easy local model deployment tool', 'deployment'),
  'moe': createStub('Mixture of Experts (MoE)', 'Scaling models with switchable layers', 'fundamentals'),
  'quantization': createStub('Model Quantization', 'Compressing models for efficient inference', 'fundamentals'),
  'vram': createStub('VRAM Requirements', 'Memory needs for running AI models', 'fundamentals'),
  'local-inference': createStub('Local Inference', 'Hardware and software considerations', 'fundamentals'),
  'transformer': createStub('Transformer Architecture', 'Deep dive into attention mechanisms', 'fundamentals'),

  // Short aliases
  'mmlu': mmlu,
  'humaneval': humaneval,
  'context-length': context,
  'fni': fni,
  'deploy-score': deploy,
  'gguf': gguf,
  'hellaswag': createStub('What is HellaSwag?', 'Commonsense reasoning benchmark', 'benchmarks'),
  'arc': createStub('What is ARC?', 'AI2 Reasoning Challenge', 'benchmarks'),
  'parameters': createStub('What are Parameters?', 'Understanding model size', 'architecture'),
  'ollama': createStub('What is Ollama?', 'Local deployment tool', 'deployment'),
};
