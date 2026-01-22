---
title: What is KV Cache?
description: Key-Value caching mechanism that accelerates autoregressive generation in transformers
keywords: kv cache, key value cache, inference, memory, paged attention, autoregressive
---

# What is KV Cache?

**KV Cache (Key-Value Cache)** is a memory optimization technique that stores previously computed attention key and value tensors during autoregressive generation, avoiding redundant computation and dramatically speeding up inference.

## The Problem

In autoregressive generation, each new token requires computing attention over all previous tokens. Without caching:

```
Token 1: Compute attention for [1]
Token 2: Compute attention for [1, 2]      ← Recomputes 1
Token 3: Compute attention for [1, 2, 3]   ← Recomputes 1, 2
...
Token N: Compute attention for [1...N]     ← Recomputes 1...(N-1)
```

This leads to O(N²) complexity for generating N tokens.

## The Solution

Cache the key (K) and value (V) projections for each layer:

```
Token 1: Compute K₁, V₁ → Cache
Token 2: Compute K₂, V₂ → Cache, use [K₁,K₂], [V₁,V₂]
Token 3: Compute K₃, V₃ → Cache, use [K₁,K₂,K₃], [V₁,V₂,V₃]
```

Now each token only requires O(N) computation, giving O(N²) total.

## Memory Requirements

KV cache memory grows with:
- **Batch size**: More sequences = more cache
- **Context length**: Longer sequences = larger cache
- **Model size**: More layers and heads = more storage

Formula:
```
KV_memory = 2 × batch × layers × heads × seq_len × head_dim × precision
```

For a 70B model with 32K context and batch 8:
- KV cache alone can use 40+ GB!

## Memory Optimization Techniques

### 1. PagedAttention (vLLM)
Manages KV cache like virtual memory pages:
- Non-contiguous memory allocation
- No fragmentation
- Efficient memory sharing between sequences

### 2. Grouped Query Attention (GQA)
Shares KV heads across multiple query heads:
- 8x reduction in KV cache for Llama 2 70B
- Minimal quality impact

### 3. Multi-Query Attention (MQA)
All query heads share a single KV pair:
- Maximum memory savings
- Some quality trade-off

### 4. Sliding Window
Only cache recent tokens:
- Fixed memory regardless of total length
- Used by Mistral models

## KV Cache in Practice

| Framework | KV Cache Strategy |
|-----------|-------------------|
| vLLM | PagedAttention |
| TensorRT-LLM | Paged KV Cache |
| Ollama | Standard caching |
| llama.cpp | Ring buffer option |

## Related Concepts

- [Flash Attention](/knowledge/flash-attention) - Efficient attention computation
- [Context Length](/knowledge/context-length) - Maximum sequence length
- [Inference Optimization](/knowledge/inference-optimization) - General optimization techniques
- [VRAM](/knowledge/vram) - GPU memory management
