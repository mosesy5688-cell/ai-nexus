---
title: What is DPO?
description: Direct Preference Optimization - a simpler alternative to RLHF for AI alignment
keywords: dpo, alignment, preference learning, rlhf alternative, training
---

# What is DPO?

**DPO (Direct Preference Optimization)** is an alignment technique that simplifies [RLHF](/knowledge/rlhf) by directly optimizing language models on preference data without training a separate reward model or using reinforcement learning.

## How DPO Works

DPO reformulates the RLHF objective as a simple classification loss:

1. **Input**: Pairs of (preferred response, rejected response) for each prompt
2. **Objective**: Increase probability of preferred response, decrease probability of rejected response
3. **Output**: Aligned model that reflects human preferences

The key insight is that the optimal policy can be derived directly from preference data using a closed-form solution.

## DPO vs RLHF

| Aspect | RLHF | DPO |
|--------|------|-----|
| Reward Model | Required | Not needed |
| RL Training | PPO optimization | Standard supervised loss |
| Stability | Can be unstable | More stable |
| Complexity | High | Low |
| Memory | Higher | Lower |
| Performance | State-of-the-art | Comparable |

## Advantages of DPO

1. **Simpler Pipeline**: No reward model training or RL loops
2. **More Stable**: Standard cross-entropy loss training
3. **Memory Efficient**: No need to load multiple models
4. **Faster Training**: Fewer stages and hyperparameters

## DPO Variants

| Variant | Description |
|---------|-------------|
| **IPO** | Identity Preference Optimization - more robust |
| **KTO** | Kahneman-Tversky Optimization - uses single examples |
| **ORPO** | Odds Ratio Preference Optimization |
| **SimPO** | Simple Preference Optimization |

## When to Use DPO

- ✅ When you have preference pairs (chosen vs rejected)
- ✅ When you want simpler training pipelines
- ✅ When GPU memory is limited
- ❌ When you need fine-grained reward shaping
- ❌ When preferences are highly noisy

## Implementation

DPO is supported in major fine-tuning frameworks:
- **TRL** (Hugging Face): `DPOTrainer`
- **Axolotl**: Built-in DPO support
- **LLaMA-Factory**: Multiple preference optimization methods

## Related Concepts

- [RLHF](/knowledge/rlhf) - Original alignment technique
- [LoRA](/knowledge/lora) - Efficient fine-tuning
- [Fine-tuning](/knowledge/fine-tuning) - General training overview
