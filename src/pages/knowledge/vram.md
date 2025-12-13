---
layout: ../../layouts/KnowledgeLayout.astro
title: VRAM Requirements
slug: vram
---

# VRAM Requirements

Understanding VRAM needs is essential for running LLMs locally.

## Estimation Formula

```
VRAM (GB) ≈ Parameters (B) × Bytes per Parameter × 1.2
```

Where:
- **FP16**: 2 bytes/param
- **INT8**: 1 byte/param
- **4-bit**: 0.5 bytes/param
- **1.2x**: Overhead for KV cache, activations

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
