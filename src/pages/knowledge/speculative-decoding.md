---
title: What is Speculative Decoding?
description: Accelerating LLM inference by using a smaller draft model to propose tokens
keywords: speculative decoding, draft model, inference speed, token generation, lookahead
---

# What is Speculative Decoding?

**Speculative Decoding** is an inference acceleration technique that uses a smaller, faster "draft" model to propose multiple tokens at once, which are then verified by the larger target model in parallel. This can achieve 2-3x speedup with no quality loss.

## How It Works

### Traditional Autoregressive Decoding
```
Token 1 → Token 2 → Token 3 → Token 4 → ...
(Each token requires a full forward pass)
```

### Speculative Decoding
```
Draft model proposes: [T1, T2, T3, T4, T5]
Target model verifies all in one pass
Accept: [T1, T2, T3] ✓  Reject: [T4, T5] ✗
Continue from T3...
```

## Key Properties

| Property | Description |
|----------|-------------|
| **Lossless** | Output is mathematically identical to target model |
| **Speedup** | 2-3x typical, depends on acceptance rate |
| **Draft Model** | Smaller version or distilled model |
| **Acceptance Rate** | Higher = faster, task-dependent |

## When Speculative Decoding Helps

- ✅ Code generation (high acceptance rate)
- ✅ Boilerplate text
- ✅ Predictable patterns
- ❌ Creative writing (low acceptance)
- ❌ Complex reasoning (unpredictable)

## Draft Model Selection

Good draft models are:
- **Much smaller**: 10-100x fewer parameters
- **Similar distribution**: Trained on similar data
- **Fast**: Low latency per token

Example pairs:
- Llama 70B + Llama 7B
- GPT-4 + GPT-3.5
- Custom distilled models

## Implementations

| Framework | Support |
|-----------|---------|
| vLLM | Built-in |
| TensorRT-LLM | Supported |
| llama.cpp | Experimental |
| Hugging Face | `assisted_generation` |

## Variants

- **Medusa**: Multiple prediction heads on same model
- **Lookahead Decoding**: No separate draft model
- **Eagle**: Efficient speculation with minimal overhead

## Related Concepts

- [Inference Optimization](/knowledge/inference-optimization) - General speedup techniques
- [KV Cache](/knowledge/kv-cache) - Memory optimization
