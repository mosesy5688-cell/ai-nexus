---
layout: ../../layouts/KnowledgeLayout.astro
title: VRAM Requirements
slug: vram
---

# VRAM Requirements

Understanding VRAM needs is essential for running LLMs locally.

## Estimation Formula

description: How much GPU memory you need to run AI models at different sizes and precisions
keywords: vram, gpu memory, llm requirements, llama 3 vram, quantization memory
---

# VRAM Requirements Guide

**VRAM (Video RAM)** is the dedicated memory on your graphics card (GPU). For Large Language Models, VRAM is the primary bottleneck. If a model doesn't fit in your VRAM, it will either run extremely slowly (using system RAM) or fail to load entirely.

## Why VRAM Matters

Unlike standard software, LLMs need to keep their entire set of "weights" in memory to generate text quickly. A model's size is determined by its **parameter count** (e.g., 7B, 70B) and its **precision** (e.g., 16-bit, 4-bit).

## VRAM Calculation formula

A rough rule of thumb for VRAM needed is:
`VRAM (GB) ≈ (Parameters in Billions * Bits per Weight) / 8 * 1.2`
*(The 1.2 factor accounts for "overhead" like context window and KV cache)*

## Requirements by Model Size

| Model Size | 4-bit (Standard) | 8-bit (High Qual) | 16-bit (Pro) |
| :--- | :--- | :--- | :--- |
| **1B - 3B** | 1.5 - 2 GB | 3 - 4 GB | 6 - 8 GB |
| **7B - 8B** | 5 - 6 GB | 8 - 10 GB | 14 - 16 GB |
| **11B - 14B** | 8 - 10 GB | 14 - 16 GB | 22 - 28 GB |
| **30B - 34B** | 18 - 20 GB | 32 - 35 GB | 60 - 70 GB |
| **70B - 72B** | 40 - 45 GB | 70 - 75 GB | 130 - 140 GB |

## Recommended GPUs for Local LLMs

### Consumer Level (Mid-Range)
-   **RTX 3060 (12GB)**: Best budget choice for 7B/8B models at high precision.
-   **RTX 4060 Ti (16GB)**: Good entry point for 14B models.

### Enthusiast Level (High-End)
-   **RTX 3090 / 4090 (24GB)**: The "Gold Standard" for local LLMs. Runs 30B models comfortably or 70B models at 2.5-bit.
-   **Dual RTX 3090 (48GB total)**: Best value for running 70B models (Llama 3) at high quality.

### Professional / Mac
-   **Mac Studio (64GB - 192GB Unified Memory)**: Best for massive models (70B+) as the M-series chips share memory between CPU and GPU.

## Context Length & KV Cache

Loading the model is only part of the story. As you chat, the "KV Cache" grows.
-   **8K Context**: Adds ~0.5 - 1GB VRAM.
-   **32K Context**: Adds ~2 - 4GB VRAM.
-   **128K Context**: Can add 10GB+ VRAM depending on the architecture.

## How to Reduce VRAM Usage

1.  **Use Quantization**: Switching from 16-bit to 4-bit reduces VRAM needs by 75%.
2.  **KV Cache Quantization**: Some tools (like vLLM or llama.cpp) can compress the cache to 4-bit/8-bit.
3.  **Context Scaling**: Limit the maximum context length in your settings.

## Related Concepts

-   [Model Quantization](/knowledge/quantization) - The primary way to save VRAM.
-   [Local Inference](/knowledge/local-inference) - Step-by-step guide to running models.
-   [KV Cache](/knowledge/kv-cache) - Understanding memory for long conversations.
-   [Flash Attention](/knowledge/flash-attention) - Technique to handle long context with less VRAM.

## Quick Reference

| Model Size | FP16 | INT8 | 4-bit |
|------------|------|------|-------|
| 7B | 14 GB | 7 GB | 4 GB |
| 13B | 26 GB | 13 GB | 7 GB |
| 34B | 68 GB | 34 GB | 18 GB |
| 70B | 140 GB | 70 GB | 35 GB |

## Context Length Impact

KV cache grows with context:

| Context | Additional VRAM (7B) |
|---------|---------------------|
| 2K | +0.5 GB |
| 8K | +2 GB |
| 32K | +8 GB |
| 128K | +32 GB |

## Consumer GPU VRAM

| GPU | VRAM | Max Model (4-bit) |
|-----|------|-------------------|
| RTX 3060 | 12 GB | ~20B |
| RTX 4070 | 12 GB | ~20B |
| RTX 4090 | 24 GB | ~45B |
| Apple M2 Pro | 16 GB | ~25B |
| Apple M3 Max | 64 GB | ~100B |

## Related Concepts

- [Quantization](/knowledge/quantization)
- [Local Inference](/knowledge/local-inference)
