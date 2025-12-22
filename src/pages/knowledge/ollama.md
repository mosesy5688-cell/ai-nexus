---
layout: ../../layouts/KnowledgeLayout.astro
title: Getting Started with Ollama
slug: ollama
---

# Getting Started with Ollama

Ollama makes running open-source LLMs locally as easy as Docker.

## Quick Start

```bash
# Install (macOS/Linux)
curl -fsSL https://ollama.com/install.sh | sh

# Run a model
ollama run llama3
```

## Popular Models

| Model | Size | Best For |
|-------|------|----------|
| llama3:8b | 4.7GB | General, fast |
| mistral:7b | 4.1GB | Balanced |
| codellama:13b | 7.4GB | Code generation |
| phi3:mini | 2.3GB | Lightweight |

## API Usage

```bash
curl http://localhost:11434/api/generate -d '{
  "model": "llama3",
  "prompt": "Why is the sky blue?"
}'
```

## GPU Support

| Platform | GPU |
|----------|-----|
| macOS | Metal (M1/M2/M3) |
| Linux | NVIDIA CUDA |
| Windows | NVIDIA CUDA |

## Tips

1. Use `-ngl` flag for GPU layers
2. Run `ollama list` to see installed models
3. Use `ollama pull model:tag` for specific versions

## Related

- [GGUF Format](/knowledge/gguf)
- [VRAM Requirements](/knowledge/vram)
- [Local Inference](/knowledge/local-inference)
