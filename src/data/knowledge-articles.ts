// src/data/knowledge-articles.ts
import { article as mmlu } from './knowledge/what-is-mmlu.js';
import { article as humaneval } from './knowledge/what-is-humaneval.js';
import { article as context } from './knowledge/what-is-context-length.js';
import { article as fni } from './knowledge/what-is-fni.js';
import { article as deploy } from './knowledge/what-is-deploy-score.js';
import { article as gguf } from './knowledge/what-is-gguf.js';

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
  content: `## Quick Overview\n\n${desc}\n\nThis article provides a foundational understanding of **${title.replace('What is ', '').replace('?', '')}**. In the current AI landscape, this concept is critical for evaluating performance and efficiency.\n\n### Key Takeaways\n- **Significance**: Essential for professional AI evaluation.\n- **Connectivity**: Linked to multiple models and papers in our Knowledge Graph.\n- **Status**: Research in progress for a deeper technical breakdown.\n\n---\n\n### Related Concepts\n- [Knowledge Hub](/knowledge)\n- [MMLU Benchmark](/knowledge/mmlu)\n- [FNI Score Explaination](/knowledge/fni)`
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
  'multimodal': createStub('Multimodal AI', 'Cross-modal processing for text and vision', 'fundamentals'),
  'rag': createStub('Retrieval Augmented Generation', 'Connecting LLMs to live data sources', 'fundamentals'),
  'llm-benchmarks': createStub('LLM Evaluation', 'Understanding MMLU, GSM8K and more', 'fundamentals'),
  'fine-tuning': createStub('Model Fine-Tuning', 'Optimizing pre-trained models for tasks', 'training'),

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
  'inference-optimization': createStub('Inference Optimization', 'How to speed up LLMs', 'inference_tech'),
  'fundamentals': createStub('AI Fundamentals', 'Core concepts and architectures', 'fundamentals'),
  'rlhf': createStub('RLHF', 'Reinforcement Learning from Human Feedback', 'training'),
  'large-language-model': createStub('Large Language Model (LLM)', 'Deep learning models trained on vast amounts of text data.', 'fundamentals'),
  'meta': createStub('Meta AI', 'Creators of the Llama series and leading open-weights research.', 'organizations'),
  'google': createStub('Google DeepMind', 'Pioneers of the Transformer architecture and Gemini models.', 'organizations'),
  'openai': createStub('OpenAI', 'Creators of GPT-4, DALL-E and the ChatGPT ecosystem.', 'organizations'),
  'mistral-ai': createStub('Mistral AI', 'European AI leader focused on efficient Mixture-of-Experts models.', 'organizations'),

  // Technical Aliases & Mesh Support (Resolved to canonicals)
  'instruction-tuning': createStub('Instruction Tuning', 'See Fine-Tuning for details.', 'training'),
  'image-generation': createStub('Image Generation', 'See Multimodal AI for details.', 'fundamentals'),
  'chat-models': createStub('Chat Models', 'See Large Language Model (LLM) for details.', 'fundamentals'),
  'context-window': createStub('Context Window', 'See Context Length for details.', 'fundamentals'),
  'mixture-of-experts': createStub('Mixture of Experts (MoE)', 'Scaling models with switchable layers', 'fundamentals'),
  'direct-preference-optimization': createStub('DPO', 'Optimizing model preferences via direct feedback.', 'training'),
};
