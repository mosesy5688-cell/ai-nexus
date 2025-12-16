export const article = {
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
};
