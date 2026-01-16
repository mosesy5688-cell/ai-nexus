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

export const articles: Record<string, KnowledgeArticle> = {
  // Full slugs
  'what-is-mmlu': mmlu,
  'what-is-humaneval': humaneval,
  'what-is-context-length': context,
  'what-is-fni': fni,
  'what-is-deploy-score': deploy,
  'what-is-gguf': gguf,
  // Short aliases for common URLs
  'mmlu': mmlu,
  'humaneval': humaneval,
  'context-length': context,
  'fni': fni,
  'deploy-score': deploy,
  'gguf': gguf,
};
