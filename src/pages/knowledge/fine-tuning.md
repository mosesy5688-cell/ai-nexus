---
layout: ../../layouts/KnowledgeLayout.astro
title: What is Fine-Tuning?
slug: fine-tuning
description: Adapting pre-trained AI models to specific tasks, domains, or styles using targeted datasets
keywords: fine-tuning, training, lora, qlora, rlhf, dpo, instruction tuning
---

# What is Fine-Tuning?

**Fine-tuning** is the process of taking a pre-trained large language model (LLM) and further training it on a smaller, specialized dataset. While the base model provides general-purpose reasoning and language patterns, fine-tuning "sharpens" the model for specific tasks, niche domains, or unique desired behaviors.

## Why Fine-Tune?

Most open-source models (like Llama 3 or Mistral) are pre-trained on trillions of tokens from the open web. Fine-tuning allows you to:

1.  **Domain Expertise**: Teach the model medical, legal, or proprietary terminology.
2.  **Instruction Following**: Ensure the model follows specific formatting or tone.
3.  **Task Optimization**: Specialize a model for code generation, summarization, or translation.
4.  **Cost Efficiency**: Use a smaller, fine-tuned model (e.g., 7B) to outperform a general 70B model on a specific task.

## Fine-Tuning vs. RAG

A common question is whether to use Fine-Tuning or [RAG (Retrieval-Augmented Generation)](/knowledge/rag). 

| Feature | Fine-Tuning | RAG |
| :--- | :--- | :--- |
| **Knowledge Base** | Internal (learned weights) | External (real-time docs) |
| **Style/Tone** | Excellent adaptation | Limited adaptation |
| **New Information** | Requires retraining | Near-instant update |
| **Hallucinations** | Higher risk | Lower risk (cites sources) |

## Common Methodologies

Modern fine-tuning rarely involves updating all model parameters (Full Fine-Tuning) due to high hardware costs. Instead, efficient PEFT (Parameter-Efficient Fine-Tuning) methods are used:

### 1. LoRA & QLoRA
[LoRA (Low-Rank Adaptation)](/knowledge/lora) and its quantized version, **QLoRA**, are the industry standards. They freeze the original model weights and only train tiny "adapter" layers, reducing the VRAM requirement by over 90%.

### 2. RLHF (Reinforcement Learning from Human Feedback)
[RLHF](/knowledge/rlhf) aligns model outputs with human preferences (helpfulness, safety) using a reward model. It's the process used to turn "Base" models into "Chat" models.

### 3. DPO (Direct Preference Optimization)
[DPO](/knowledge/dpo) is a newer, simpler alternative to RLHF that directly optimizes the model on preference pairs (A is better than B) without needing a separate reward model.

## Popular Tools

-   **Unsloth**: Extremely fast and memory-efficient fine-tuning for consumer GPUs.
-   **Axolotl**: A popular configuration-based framework for training various LLMs.
-   **Hugging Face PEFT**: The foundational library for all parameter-efficient methods.
-   **LLaMA-Factory**: A comprehensive web UI and CLI for end-to-end fine-tuning.

## Related Concepts

-   [LoRA](/knowledge/lora) - The most popular efficient training method.
-   [RLHF](/knowledge/rlhf) - Aligning models with human values.
-   [VRAM Requirements](/knowledge/vram) - Hardware needed for training.
-   [Dataset Curation](/knowledge/datasets) - Selecting high-quality training pairs.
