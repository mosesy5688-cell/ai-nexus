---
layout: ../../layouts/KnowledgeLayout.astro
title: What is RLHF?
slug: rlhf
description: Reinforcement Learning from Human Feedback - the key technique for aligning AI with human preferences
keywords: rlhf, alignment, reward model, ppo, human feedback, safety
---

# What is RLHF?

**RLHF (Reinforcement Learning from Human Feedback)** is a training technique that aligns language models with human preferences by using human feedback as a reward signal. It's the key innovation behind ChatGPT and other instruction-following models.

## The RLHF Pipeline

RLHF consists of three main stages:

### Stage 1: Supervised Fine-Tuning (SFT)
Train the base model on high-quality demonstration data to learn basic instruction-following behavior.

### Stage 2: Reward Model Training
1. Generate multiple responses for each prompt
2. Human annotators rank responses by quality
3. Train a reward model to predict human preferences

### Stage 3: RL Optimization (PPO)
Use Proximal Policy Optimization to fine-tune the SFT model:
- Generate responses from current policy
- Score responses with reward model
- Update policy to maximize reward while staying close to SFT model

## Why RLHF Matters

| Challenge | How RLHF Helps |
|-----------|----------------|
| Helpfulness | Optimizes for user satisfaction |
| Harmlessness | Penalizes harmful outputs |
| Honesty | Rewards accurate, calibrated responses |
| Instruction Following | Aligns with user intent |

## Limitations

- **Expensive**: Requires extensive human annotation
- **Reward Hacking**: Models may exploit reward model weaknesses
- **Preference Diversity**: Hard to capture diverse human preferences
- **Scalability**: Human feedback doesn't scale easily

## Alternatives to RLHF

| Method | Description | Advantage |
|--------|-------------|-----------|
| [DPO](/knowledge/dpo) | Direct preference optimization | No reward model needed |
| RLAIF | AI-generated feedback | Scales better |
| Constitutional AI | Rule-based self-improvement | More controllable |

## Notable RLHF Models

- **GPT-4**: OpenAI's flagship model
- **Claude**: Anthropic's assistant
- **LLaMA 2 Chat**: Meta's aligned models
- **Gemini**: Google's multimodal model

## Related Concepts

- [DPO](/knowledge/dpo) - Alternative alignment method
- [Fine-tuning](/knowledge/fine-tuning) - General training overview
