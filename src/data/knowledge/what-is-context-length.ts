export const article = {
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
};
