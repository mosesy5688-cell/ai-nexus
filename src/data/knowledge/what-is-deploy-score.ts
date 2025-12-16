export const article = {
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
};
