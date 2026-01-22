---
layout: ../../layouts/KnowledgeLayout.astro
title: What is Flash Attention?
slug: flash-attention
description: Memory-efficient attention algorithm that enables longer context and faster inference
keywords: flash attention, attention mechanism, memory optimization, long context, inference speed
---

# What is Flash Attention?

**Flash Attention** is an optimized attention algorithm that computes exact attention with O(N) memory instead of O(N²), enabling longer context lengths and 2-4x faster training and inference on modern GPUs.

## The Attention Bottleneck

Standard attention has two major issues:

1. **Memory**: Stores full N×N attention matrix (quadratic memory)
2. **Speed**: Memory bandwidth becomes the bottleneck, not compute

For a 32K context model, the attention matrix alone would require 4GB of memory per layer!

## How Flash Attention Works

Flash Attention uses **tiling** and **recomputation**:

1. **Tiling**: Process attention in blocks that fit in GPU SRAM
2. **Kernel Fusion**: Combine operations to minimize memory transfers
3. **Recomputation**: Recompute values during backward pass instead of storing

This achieves the same mathematical result with dramatically less memory.

## Performance Impact

| Metric | Standard Attention | Flash Attention |
|--------|-------------------|-----------------|
| Memory | O(N²) | O(N) |
| Speed | 1x | 2-4x faster |
| Max Context | ~8K | 128K+ |
| Training Throughput | Baseline | 2-3x higher |

## Flash Attention Versions

| Version | Key Features |
|---------|--------------|
| **v1** | Tiling, online softmax |
| **v2** | Better parallelism, 2x faster |
| **v3** | Hopper GPU optimizations (H100) |

## Enabling Flash Attention

Most modern frameworks support Flash Attention:

```python
# Hugging Face Transformers
model = AutoModelForCausalLM.from_pretrained(
    "model_name",
    attn_implementation="flash_attention_2"
)
```

## Requirements

- **GPU**: NVIDIA Ampere (A100) or newer recommended
- **CUDA**: 11.6+
- **PyTorch**: 2.0+

## Related Optimizations

| Technique | Description |
|-----------|-------------|
| **PagedAttention** | Used in vLLM for serving |
| **Ring Attention** | Distributes attention across GPUs |
| **Sliding Window** | Limits attention to local context |

## Related Concepts

- [Context Length](/knowledge/context-length) - Input sequence limits
- [Transformer](/knowledge/transformer) - Architecture overview
- [VRAM](/knowledge/vram) - GPU memory management
