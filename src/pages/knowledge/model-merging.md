---
title: What is Model Merging?
description: Combining multiple fine-tuned models into a single model without additional training
keywords: model merging, mergekit, frankenmerge, slerp, ties, dare
---

# What is Model Merging?

**Model Merging** is a technique for combining multiple fine-tuned models into a single model without additional training. It enables creating specialized models by blending capabilities from different sources.

## Why Merge Models?

- **Combine Strengths**: Merge a code model with a chat model
- **No Training Required**: Works with just the weights
- **Reduce Costs**: Skip expensive training runs
- **Community Innovation**: Build on others' work

## Merging Methods

### 1. Linear Interpolation (LERP)
Simple weighted average of weights.
```
merged = α * model_a + (1-α) * model_b
```

### 2. SLERP (Spherical Linear Interpolation)
Interpolates along the hypersphere, preserving model geometry.
- Better for models that are far apart in weight space
- Smoother transitions between capabilities

### 3. TIES (Task Interference-aware Extraction and Specialization)
Intelligent merging that resolves parameter conflicts:
1. Trim small magnitude changes
2. Resolve sign conflicts
3. Merge remaining parameters

### 4. DARE (Drop And REscale)
Randomly drops delta parameters before merging:
- Reduces interference between models
- Often combined with TIES

### 5. Passthrough / Frankenmerge
Stack layers from different models:
```
Layers 0-15: Model A
Layers 16-31: Model B
```

## Popular Merging Tools

| Tool | Features |
|------|----------|
| **mergekit** | Most popular, supports all methods |
| **PEFT merge** | Merge LoRA adapters |
| **LazyMergekit** | Web interface for merging |

## Merge Recipes

Common successful patterns:

1. **Base + Instruct**: Merge base with instruction-tuned
2. **Chat + Code**: Combine conversational and coding abilities
3. **DPO + SFT**: Layer alignment on top of instruction-tuning

## Evaluating Merged Models

Always test merged models on:
- General benchmarks (MMLU, HellaSwag)
- Task-specific tests
- Real-world use cases

## Limitations

- ❌ No guarantee of success
- ❌ Can lose capabilities from either model
- ❌ May introduce inconsistencies
- ❌ Hard to predict which method works best

## Related Concepts

- [LoRA](/knowledge/lora) - Efficient fine-tuning for merge sources
- [Fine-tuning](/knowledge/fine-tuning) - Creating models to merge
- [Quantization](/knowledge/quantization) - Compressing merged models
