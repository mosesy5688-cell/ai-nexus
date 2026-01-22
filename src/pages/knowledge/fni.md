---
layout: ../../layouts/KnowledgeLayout.astro
title: What is the FNI Score?
slug: fni
description: Understanding the Freshness-Novelty Index used by AI Nexus Hub to rank and discover trending AI models
keywords: fni score, freshness, novelty, ai ranking, trending models, evaluation
---

# What is the FNI Score?

The **Freshness-Novelty Index (FNI)** is a proprietary scoring algorithm developed by **Neural Mesh Hub** to help users separate the "signal from the noise" in the rapidly evolving AI landscape. While traditional leaderboards (like MMLU) focus on raw intelligence, FNI focuses on **momentum**, **uniqueness**, and **recent impact**.

## How FNI is Calculated

FNI isn't a single number; it's a weighted composite of four key dimensions, mapped to the acronym **P.V.C.U**:

### 1. Popularity (P)
Measures the rate of adoption. We track download growth, GitHub stars, and social mentions over the last 14 days. 
-   *A model that gains 10k stars in a week gets a much higher P-score than an old model with 100k total stars.*

### 2. Velocity (V)
Tracks how quickly the model's ecosystem is growing. This includes the number of fine-tunes (adapters), spaces, and quantization files being created by the community.

### 3. Context & Capability (C)
Evaluates if the model introduces significant architectural improvements (e.g., massive context window, lower VRAM requirements at higher accuracy).

### 4. Uniqueness (U)
The "Novelty" factor. Does this model fill a new niche? (e.g., a tiny 1B model that outperforms 7B models, or the first model specifically for a rare language).

## Interpreting FNI Scores

| FNI Percentile | Label | Meaning |
| :--- | :--- | :--- |
| **95% - 100%** | 🌈 **Viral Breakout** | A generational shift or massive community phenomenon (e.g., Llama 3 launch). |
| **80% - 94%** | 🔥 **Trending High** | Significant momentum; the current benchmark for its class. |
| **50% - 79%** | 📈 **Steady Growth** | Reliable models that are gaining consistent professional use. |
| **< 50%** | ❄️ **Cooling/Static** | Established models that are no longer the primary focus of active research. |

## Why FNI Matters

Hugging Face has over 500,000 models. 99% of them are stale or minor variations. FNI allows you to:
-   **Discover Hidden Gems**: Find small, high-U models before they go viral.
-   **Verify Hype**: See if a new model has the "Velocity" to back up its marketing claims.
-   **Stay Professional**: Focus your fine-tuning or deployment efforts on models with a growing ecosystem.

## Related Concepts

-   [LLM Benchmarks](/knowledge/llm-benchmarks) - Traditional ways to measure IQ.
-   [Llama Family Guide](/knowledge/llama) - Common high-FNI models.
-   [Local Inference](/knowledge/local-inference) - How to run trending models.
-   [VRAM Requirements](/knowledge/vram) - Hardware needed for new breakthroughs.
