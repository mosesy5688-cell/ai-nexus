---
layout: ../../layouts/KnowledgeLayout.astro
title: Mixture of Experts (MoE)
slug: moe
description: Scaling AI models efficiently using sparse architecture and conditional computation
keywords: moe, mixture of experts, sparse models, mistral, mixtral, gating network
---

# What is Mixture of Experts (MoE)?

**Mixture of Experts (MoE)** is a neural network architecture that significantly increases a model's total capacity (parameters) without a proportional increase in the computational cost (FLOPs) during inference. It achieved mainstream fame with the release of **Mixtral 8x7B**.

## How It Works

Traditional models are "Dense," meaning every single parameter is used for every word the model generates. MoE models are "**Sparse**."

### 1. The Experts
Instead of one massive layer, an MoE model has multiple smaller sub-networks called **Experts**. Each expert specializes in different types of data or patterns.

### 2. The Gating Network (The Router)
The "Brain" of the operation is the **Gating Network**. For every incoming token (word), the Router decides which experts are best suited to handle it.
-   **Example**: If the model is translating French, the Router might send the token to the "Grammar Expert" and the "French Specialist" while ignoring the "Coding Expert."

## MoE vs. Dense Models

| Feature | Dense Model (GPT-3) | MoE Model (Mixtral) |
| :--- | :--- | :--- |
| **Total Parameters** | All active | High total, low active |
| **Inference Cost** | Constant | Variable/Lower |
| **VRAM Required** | Proportional to size | Proportional to total size |
| **Training Efficiency** | Harder to scale | Easier to scale wide |

## Why MoE is Popular

1.  **Speed**: A model like Mixtral 8x7B has ~47B total parameters but only uses ~13B for each token. This makes it as fast as a much smaller model while having the knowledge of a large one.
2.  **Scalability**: Researchers can add more experts to increase model smarts without making it significantly slower.

## Notable MoE Models

-   **Mixtral 8x7B**: The model that proved open-source MoE could rival GPT-3.5.
-   **GPT-4**: Widely rumored to be a massive MoE system (approx. 16 experts / 1.8 trillion parameters).
-   **DeepSeek-V2**: A highly efficient MoE model that pushes the limits of active vs. total parameters.

## Current Trade-offs

-   **VRAM Consumption**: While an MoE model is fast to run, you still need enough VRAM to store **all** the experts. A 47B MoE model requires as much memory as a 47B Dense model.
-   **Training Complexity**: Keeping all experts "balanced" during training so that one doesn't become a "jack of all trades" is difficult.

## Related Concepts

-   [Transformer Architecture](/knowledge/transformer) - The base of MoE systems.
-   [Model Parameters](/knowledge/parameters) - Total vs. Active weights.
-   [Inference Optimization](/knowledge/inference-optimization) - Making models run faster.
-   [Mixtral 8x7B](/knowledge/mixtral) - The landmark open source MoE model.
