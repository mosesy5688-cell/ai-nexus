---
layout: ../../layouts/KnowledgeLayout.astro
title: Local Inference
slug: local-inference
---

# Local Inference

Run LLMs on your own hardware for privacy, cost savings, and offline access.

## Popular Tools

| Tool | Platform | Best For |
|------|----------|----------|
| **Ollama** | Mac/Linux/Win | Easy setup |
| **llama.cpp** | All | Performance |
| **LM Studio** | Mac/Win | GUI |
| **vLLM** | Linux | Serving |
| **text-gen-webui** | All | Features |

## Quick Start: Ollama

```bash
# Install
curl -fsSL https://ollama.com/install.sh | sh

# Run a model
ollama run llama3.2

# List models
ollama list
```

## Hardware Requirements

### Minimum (7B models)
- 8 GB RAM
- 4-core CPU
- (Optional) 8+ GB VRAM GPU

### Recommended (13-34B models)
- 16 GB RAM
- 8-core CPU
- 12+ GB VRAM GPU

### Power User (70B+ models)
- 32 GB RAM
- High-end GPU (24+ GB) or
- Apple Silicon (32+ GB unified)

## Performance Tips

1. **Use quantized models** (Q4_K_M balance)
2. **GPU offloading** when possible
3. **Limit context length** if RAM constrained
4. **Use MoE models** for efficiency

## Related Concepts

- [VRAM Requirements](/knowledge/vram)
- [Quantization](/knowledge/quantization)
