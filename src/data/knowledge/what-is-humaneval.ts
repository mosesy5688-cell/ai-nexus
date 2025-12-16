export const article = {
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
};
