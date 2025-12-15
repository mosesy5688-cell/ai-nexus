---
layout: ../../layouts/KnowledgeLayout.astro
title: What is GGUF?
slug: gguf
---

# What is GGUF?

GGUF (GPT-Generated Unified Format) is a file format for storing quantized large language models optimized for efficient CPU and GPU inference.

## Overview

GGUF is the successor to GGML, designed by Georgi Gerganov for use with [llama.cpp](https://github.com/ggerganov/llama.cpp). It has become the standard format for running LLMs locally.

## Key Benefits

| Feature | Benefit |
|---------|---------|
| **CPU Inference** | Run models without expensive GPUs |
| **Apple Silicon** | Optimized for M1/M2/M3 chips |
| **Multiple Quants** | Choose quality vs. memory tradeoff |
| **Wide Support** | Works with Ollama, LM Studio, llama.cpp |

## Quantization Levels

| Quant | Bits/Weight | Quality | Use Case |
|-------|-------------|---------|----------|
| Q8_0 | 8.5 | Best | Maximum quality |
| Q6_K | 6.6 | Excellent | Great balance |
| Q5_K_M | 5.7 | Great | Recommended for most |
| Q4_K_M | 4.8 | Good | Memory constrained |
| Q3_K_M | 3.9 | Acceptable | Very low memory |
| Q2_K | 2.6 | Lossy | Extreme limits |

## VRAM/RAM Requirements (7B Model)

| Quant | Memory Required |
|-------|-----------------|
| Q8_0 | ~8 GB |
| Q5_K_M | ~5 GB |
| Q4_K_M | ~4 GB |
| Q2_K | ~3 GB |

## How to Use GGUF Models

### With Ollama
```bash
ollama run model-name
```

### With llama.cpp
```bash
./llama-cli -m model.gguf -p "Your prompt here"
```

### With LM Studio
1. Download the GGUF file
2. Import into LM Studio
3. Start chatting

## Finding GGUF Models

On Free2AITools, look for the **GGUF** badge on model cards. Models with GGUF support have higher Deploy Scores.

## Related Concepts

- [Model Quantization](/knowledge/quantization)
- [VRAM Requirements](/knowledge/vram)
- [Local Inference](/knowledge/local-inference)
