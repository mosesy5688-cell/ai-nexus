
// src/data/knowledge-articles.ts
export interface KnowledgeArticle {
    title: string;
    description: string;
    category: string;
    content: string;
}

export const articles: Record<string, KnowledgeArticle> = {
    'what-is-mmlu': {
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
    },
    'what-is-humaneval': {
        title: 'What is HumanEval?',
        description: 'HumanEval is a benchmark for evaluating code generation capabilities of language models using Python programming problems.',
        category: 'Benchmarks',
        content: `
  ## Overview
  
  **HumanEval** is OpenAI's benchmark for evaluating code generation capabilities. It consists of 164 hand-written Python programming problems.
  
  ## What It Measures
  
  Each problem includes:
  - Function signature
  - Docstring describing the task
  - Unit tests for verification
  
  Models must generate working code that passes all tests.
  
  ## Scoring (pass@k)
  
  - **pass@1**: Probability of first attempt being correct
  - **pass@10**: Probability of at least one of 10 attempts being correct
  - **pass@100**: With 100 attempts
  
  ## Top Performers (2024)
  
  | Model | pass@1 |
  |-------|--------|
  | Claude 3.5 Sonnet | 92% |
  | GPT-4o | 91% |
  | DeepSeek-V2.5 | 85% |
  | Qwen2.5-72B | 87% |
  
  ## Why It Matters
  
  - Tests practical programming ability
  - Objectively verified (code runs or doesn't)
  - Relevant for coding assistants
  
  ## Related Benchmarks
  
  - **MBPP**: Mostly Basic Python Problems
  - **HumanEval+**: Extended with more tests
  - **SWE-Bench**: Real-world GitHub issues
      `
    },
    'what-is-context-length': {
        title: 'What is Context Length?',
        description: 'Context length is the maximum number of tokens a language model can process at once, determining how much text it can "remember".',
        category: 'Architecture',
        content: `
  ## Overview
  
  **Context length** (or context window) is the maximum number of tokens a language model can process in a single request.
  
  ## Token Basics
  
  - 1 token ≈ 4 characters in English
  - 1 token ≈ 0.75 words
  - 1000 tokens ≈ 750 words
  
  ## Common Context Lengths
  
  | Size | Tokens | Approx. Words |
  |------|--------|---------------|
  | Small | 4K | 3,000 |
  | Medium | 8K | 6,000 |
  | Large | 32K | 24,000 |
  | Extended | 128K | 96,000 |
  | Ultra | 1M+ | 750,000+ |
  
  ## Why It Matters
  
  **Longer context = more capability:**
  - Process entire documents
  - Maintain conversation history
  - Analyze codebases
  - Compare multiple sources
  
  ## Trade-offs
  
  | Larger Context | Smaller Context |
  |----------------|-----------------|
  | ✅ More information | ✅ Faster inference |
  | ❌ Slower processing | ❌ Limited memory |
  | ❌ Higher memory usage | ✅ Lower cost |
  | ❌ May lose focus | ✅ More focused |
  
  ## Models by Context Length
  
  - **128K+**: GPT-4o, Claude 3.5, DeepSeek-V2.5
  - **32K**: Qwen2.5, Mistral
  - **8K**: Llama 3.1, Gemma 2
      `
    },
    'what-is-fni': {
        title: 'What is FNI?',
        description: 'Fair Nexus Index (FNI) is our transparent, multi-dimensional scoring system for ranking AI models on Free2AITools.',
        category: 'Metrics',
        content: `
  ## Overview
  
  **FNI (Fair Nexus Index)** is Free2AITools' proprietary scoring system for ranking AI models. It provides a transparent, multi-dimensional view of model quality.
  
  ## The Four Dimensions
  
  ### P - Popularity (30%)
  - Download counts
  - Like counts
  - Community adoption
  
  ### V - Velocity (25%)
  - 7-day growth rate
  - Trending momentum
  - Recent activity
  
  ### C - Credibility (25%)
  - Benchmark scores (MMLU, HumanEval, etc.)
  - Organization reputation
  - Documentation quality
  
  ### U - Utility (20%)
  - Deploy score
  - Format availability (GGUF, Ollama)
  - Practical usability
  
  ## Score Range
  
  | FNI Score | Percentile | Interpretation |
  |-----------|------------|----------------|
  | 90+ | Top 1% | Exceptional |
  | 75-90 | Top 10% | Excellent |
  | 50-75 | Top 25% | Good |
  | 25-50 | Average | Moderate |
  | <25 | Below Average | Limited |
  
  ## Why FNI?
  
  - **Transparent**: All factors explained
  - **Multi-dimensional**: Not just downloads
  - **Updated daily**: Fresh rankings
  - **Fair**: Considers smaller models too
  
  ## How to Improve FNI
  
  1. Publish quality benchmarks
  2. Provide GGUF/Ollama support
  3. Write good documentation
  4. Engage community
      `
    },
    'what-is-deploy-score': {
        title: 'What is Deploy Score?',
        description: 'Deploy Score measures how easily a model can be deployed and run locally, considering factors like size, format availability, and tool support.',
        category: 'Metrics',
        content: `
  ## Overview
  
  **Deploy Score** is a 0-1.0 metric that measures how easily an AI model can be deployed and run locally or in production.
  
  ## Score Formula (V4.4)
  
  \`\`\`
  Deploy Score = 
    0.25 × GGUF availability +
    0.25 × Ollama availability +
    0.20 × Context length factor +
    0.15 × Size factor +
    0.15 × Quantization formats
  \`\`\`
  
  ## Factors Explained
  
  ### GGUF Availability (+25%)
  Models with GGUF quantized versions are much easier to run locally using llama.cpp, Ollama, or LM Studio.
  
  ### Ollama Support (+25%)
  If a model is available in the Ollama library, deployment is as simple as:
  \`\`\`bash
  ollama run model-name
  \`\`\`
  
  ### Context Length (+0-20%)
  Longer context = more useful, but also harder to run:
  - 32K+: +20%
  - 8K-32K: +15%
  - 4K-8K: +10%
  - <4K: +5%
  
  ### Model Size (+5-15%)
  Smaller models are easier to deploy:
  - <10B: +15%
  - 10-40B: +10%
  - 40B+: +5%
  
  ### Quantization Formats (+0-15%)
  More quantization options = more flexibility:
  - Q4, Q5, Q8, FP16, etc.
  
  ## Score Interpretation
  
  | Score | Deployment Ease |
  |-------|-----------------|
  | 0.8+ | Excellent - One-click deploy |
  | 0.5-0.8 | Good - Some setup required |
  | 0.3-0.5 | Moderate - Technical knowledge needed |
  | <0.3 | Complex - Significant resources required |
      `
    },
    'what-is-gguf': {
        title: 'What is GGUF?',
        description: 'GGUF (GPT-Generated Unified Format) is a file format for storing quantized LLMs optimized for efficient CPU and GPU inference.',
        category: 'Deployment',
        content: `
  ## Overview
  
  **GGUF** is the standard format for running LLMs locally. Created by Georgi Gerganov for llama.cpp, it enables efficient inference on CPUs and Apple Silicon.
  
  ## Key Benefits
  
  | Feature | Benefit |
  |---------|---------|
  | **CPU Inference** | Run models without expensive GPUs |
  | **Apple Silicon** | Optimized for M1/M2/M3 chips |
  | **Multiple Quants** | Choose quality vs. memory tradeoff |
  | **Wide Support** | Works with Ollama, LM Studio, llama.cpp |
  
  ## Quantization Levels
  
  | Quant | Bits | Quality | Memory (7B) |
  |-------|------|---------|-------------|
  | Q8_0 | 8.5 | Best | ~8 GB |
  | Q5_K_M | 5.7 | Great | ~5 GB |
  | Q4_K_M | 4.8 | Good | ~4 GB |
  | Q2_K | 2.6 | Lossy | ~3 GB |
  
  ## How to Use
  
  **With Ollama:**
  \`\`\`bash
  ollama run model-name
  \`\`\`
  
  **With llama.cpp:**
  \`\`\`bash
  ./llama-cli -m model.gguf -p "Your prompt"
  \`\`\`
  
  ## Related Concepts
  
  - Model Quantization
  - VRAM Requirements  
  - Local Inference
      `
    }
};
