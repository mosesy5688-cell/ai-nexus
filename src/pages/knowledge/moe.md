---
layout: ../../layouts/KnowledgeLayout.astro
title: Mixture of Experts (MoE)
slug: moe
---

# Mixture of Experts (MoE)

MoE is an architecture that uses conditional computation to scale models efficiently.

## How It Works

Instead of activating all parameters, MoE routes each token to a subset of "expert" networks:

```
y = Σ G(x)_i · E_i(x)
```

- **G(x)**: Gating function (router)
- **E_i**: Expert network
- **Top-k**: Usually 1-2 experts active per token

## Benefits

| Aspect | Dense Model | MoE Model |
|--------|-------------|-----------|
| Total Params | 70B | 141B (8x8) |
| Active Params | 70B | ~17B |
| VRAM (inference) | 140GB | ~35GB |
| Speed | Baseline | Faster per token |

## Notable MoE Models

- **Mixtral 8x7B**: 8 experts, 2 active, ~13B active
- **DeepSeek-V2**: 236B total, 21B active
- **Qwen MoE**: Multiple variants

## Trade-offs

✅ **Pros**:
- More capacity with less compute
- Efficient inference

⚠️ **Cons**:
- Complex training
- Higher total VRAM for full model
- Router quality matters

## Related Concepts

- [Transformer Architecture](/knowledge/transformer)
- [VRAM Requirements](/knowledge/vram)
