---
layout: ../../layouts/KnowledgeLayout.astro
title: What is AWQ?
slug: awq
description: Activation-aware Weight Quantization - an efficient 4-bit quantization method
keywords: awq, quantization, 4-bit, activation aware, weight quantization, inference
---

# What is AWQ?

**AWQ (Activation-aware Weight Quantization)** is a 4-bit quantization technique that preserves model accuracy by protecting salient weights based on activation patterns. It achieves better quality than naive quantization while enabling 4-bit inference.

## How AWQ Works

AWQ's key insight: only ~1% of weights are critical for accuracy.

1. **Identify Salient Weights**: Analyze activations to find important weights
2. **Protect via Scaling**: Scale salient channels to reduce quantization error
3. **Quantize**: Apply 4-bit quantization to all weights
4. **Absorb Scales**: Merge scaling into adjacent layers

## AWQ vs Other Methods

| Method | Bits | Quality | Speed | Calibration |
|--------|------|---------|-------|-------------|
| FP16 | 16 | Baseline | 1x | None |
| GPTQ | 4 | Good | 3-4x | Required |
| **AWQ** | 4 | **Better** | **3-4x** | **Faster** |
| GGUF Q4 | 4 | Good | 2-3x | None |

## Advantages of AWQ

1. **Better Quality**: Outperforms GPTQ at same bit-width
2. **Faster Calibration**: Minutes vs hours for GPTQ
3. **Efficient Kernels**: Optimized CUDA implementations
4. **Hardware Friendly**: Works well with tensor cores

## When to Use AWQ

- ✅ GPU inference requiring speed
- ✅ Memory-constrained deployment
- ✅ When quality matters more than GPTQ
- ❌ CPU inference (use GGUF instead)
- ❌ Very small models (overhead not worth it)

## AWQ in Practice

```python
from awq import AutoAWQForCausalLM

model = AutoAWQForCausalLM.from_quantized(
    "TheBloke/Llama-2-7B-AWQ",
    fuse_layers=True
)
```

## Popular AWQ Models

Many HuggingFace models are available in AWQ format:
- TheBloke's AWQ collection
- Official vendor AWQ releases
- Community quantizations

## Memory Savings

| Model | FP16 | AWQ 4-bit | Savings |
|-------|------|-----------|---------|
| 7B | 14 GB | 4 GB | 71% |
| 13B | 26 GB | 8 GB | 69% |
| 70B | 140 GB | 40 GB | 71% |

## Related Concepts

- [Quantization](/knowledge/quantization) - General quantization overview
- [GGUF](/knowledge/gguf) - Alternative quantization format
- [VRAM](/knowledge/vram) - GPU memory requirements
