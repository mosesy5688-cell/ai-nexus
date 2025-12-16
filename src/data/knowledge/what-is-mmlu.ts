export const article = {
    title: 'What is MMLU?',
    description: 'Massive Multitask Language Understanding (MMLU) is a benchmark designed to measure knowledge acquired during pretraining by evaluating models on 57 subjects.',
    category: 'Benchmarks',
    content: `
  ## Overview
  
  **MMLU (Massive Multitask Language Understanding)** is one of the most widely used benchmarks for evaluating large language models. It tests a model's knowledge and reasoning abilities across 57 different subjects.
  
  ## What It Measures
  
  MMLU evaluates models on:
  
  - **Humanities**: History, Philosophy, Law
  - **STEM**: Mathematics, Physics, Computer Science
  - **Social Sciences**: Economics, Psychology, Sociology
  - **Other**: Professional exams, General knowledge
  
  ## Scoring
  
  Models are scored as a percentage of correct answers:
  
  | Score Range | Interpretation |
  |-------------|----------------|
  | 85%+ | Excellent (PhD-level) |
  | 70-85% | Good (Graduate-level) |
  | 50-70% | Fair (Undergraduate-level) |
  | <50% | Needs improvement |
  
  ## Top Performers (2024)
  
  1. **GPT-4o**: ~90%
  2. **Claude 3.5 Sonnet**: ~88%
  3. **Qwen2.5-72B**: ~85%
  4. **Llama 3.1 70B**: ~82%
  
  ## Why It Matters
  
  MMLU is important because:
  
  - Tests broad knowledge, not just language fluency
  - Covers real-world subjects relevant to users
  - Widely adopted, enabling fair comparison
  - Correlates well with real-world usefulness
  
  ## Limitations
  
  - Primarily English-focused
  - Multiple-choice format only
  - Static dataset (knowledge cutoff)
  - Doesn't test reasoning chains
  
  ## Related Benchmarks
  
  - **MMLU-Pro**: Extended version with harder questions
  - **ARC**: Science reasoning questions
  - **HellaSwag**: Commonsense reasoning
      `
};
