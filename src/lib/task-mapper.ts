/**
 * Task → pipeline_tag alias mapping for select_model API.
 * 30 alias groups covering common Agent/developer phrasings.
 */

const TASK_ALIASES: Record<string, string> = {
  'llm': 'text-generation',
  'chat': 'text-generation',
  'chatbot': 'text-generation',
  'code': 'text-generation',
  'code-generation': 'text-generation',
  'coding': 'text-generation',
  'write': 'text-generation',
  'generate-text': 'text-generation',
  'completion': 'text-generation',
  'instruct': 'text-generation',
  'assistant': 'text-generation',
  'diffusion': 'text-to-image',
  'image-generation': 'text-to-image',
  'art': 'text-to-image',
  'generate-image': 'text-to-image',
  'stable-diffusion': 'text-to-image',
  'translate': 'translation',
  'translator': 'translation',
  'summarize': 'summarization',
  'summarise': 'summarization',
  'speech-to-text': 'automatic-speech-recognition',
  'transcribe': 'automatic-speech-recognition',
  'asr': 'automatic-speech-recognition',
  'voice': 'text-to-speech',
  'tts': 'text-to-speech',
  'classify': 'text-classification',
  'sentiment': 'text-classification',
  'ner': 'token-classification',
  'qa': 'question-answering',
  'rag': 'feature-extraction',
  'embeddings': 'feature-extraction',
  'embed': 'feature-extraction',
  'embedding': 'feature-extraction',
  'rerank': 'feature-extraction',
  'detect': 'object-detection',
  'segment': 'image-segmentation',
  'ocr': 'image-to-text',
  'caption': 'image-to-text',
  'fill-mask': 'fill-mask',
  'video': 'text-to-video',
  'audio': 'text-to-audio',
  'depth': 'depth-estimation',
};

const KNOWN_TAGS = new Set([
  'text-generation', 'text2text-generation', 'text-to-image', 'image-to-text',
  'text-classification', 'token-classification', 'question-answering',
  'summarization', 'translation', 'fill-mask', 'feature-extraction',
  'sentence-similarity', 'automatic-speech-recognition', 'text-to-speech',
  'text-to-audio', 'text-to-video', 'object-detection', 'image-segmentation',
  'image-classification', 'depth-estimation', 'zero-shot-classification',
  'conversational', 'reinforcement-learning', 'tabular-classification',
  'unconditional-image-generation', 'image-to-image',
]);

export interface TaskMapResult {
  tag: string;
  confidence: number;
}

export function mapTaskToTag(input: string): TaskMapResult {
  if (!input) return { tag: 'text-generation', confidence: 0.3 };
  const normalized = input.toLowerCase().trim();

  if (KNOWN_TAGS.has(normalized)) {
    return { tag: normalized, confidence: 1.0 };
  }

  const alias = TASK_ALIASES[normalized];
  if (alias) {
    return { tag: alias, confidence: 0.9 };
  }

  for (const [key, tag] of Object.entries(TASK_ALIASES)) {
    if (normalized.includes(key)) {
      return { tag, confidence: 0.7 };
    }
  }

  return { tag: normalized, confidence: 0.5 };
}

export function getRankingsDbForTask(tag: string): string {
  return 'rankings-model.db';
}
