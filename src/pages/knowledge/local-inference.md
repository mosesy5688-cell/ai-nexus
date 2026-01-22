---
layout: ../../layouts/KnowledgeLayout.astro
title: Local AI Inference Guide
slug: local-inference
description: A comprehensive guide to running LLMs on your own hardware for privacy, speed, and customization
keywords: local llm, inference, ollama, lm studio, llama.cpp, gpu requirements, private ai
---

# Local AI Inference Guide

**Local Inference** refers to running Large Language Models (LLMs) on your own hardware (laptop, desktop, or server) instead of relying on cloud APIs like OpenAI or Anthropic. This shift is driven by the need for **privacy**, **offline access**, and **zero per-token costs**.

## Benefits of Going Local

-   **Data Privacy**: Your prompts and data never leave your machine. Ideal for sensitive documents.
-   **Zero Latency/Cost**: No waiting for rate limits or paying monthly subscriptions.
-   **Customization**: Run uncensored models or fine-tune models to your specific needs.
-   **Offline Access**: Use AI in the field or in secure environments without internet.

## Popular Local LLM Tools

| Tool | Difficulty | Best For... | Platform |
| :--- | :--- | :--- | :--- |
| **Ollama** | Beginner | One-line terminal commands | Win / Mac / Linux |
| **LM Studio** | Beginner | Visual GUI & discovering models | Win / Mac |
| **llama.cpp** | Advanced | Maximum performance & efficiency | CLI / All |
| **Jan.ai** | Intermediate | Local alternative to ChatGPT | Desktop |
| **vLLM** | Pro | High-throughput serving / API | Linux / GPU |

## Hardware Cheat Sheet

### 1. Apple Silicon (MacBook M1/M2/M3)
The "Unified Memory" architecture makes Macs a powerhouse for local AI. 
-   **8GB RAM**: 1B - 3B models (Phi-3, Gemma-2b).
-   **16GB+ RAM**: 7B - 8B models (Llama 3, Mistral) run excellently.
-   **64GB+ RAM**: Can run 70B models comfortably.

### 2. PC with NVIDIA GPU
Look for GPUs with at least **8GB VRAM** (RTX 3060/4060). 
-   **RTX 3090/4090 (24GB)**: The king of local AI for consumers.

### 3. CPU Only
Possible with **llama.cpp**, but slow. Good for 3B-7B models if you are patient (1-3 tokens per second).

## How to Get Started (The 5-Minute Path)

1.  **Download Ollama** from [ollama.com](https://ollama.com).
2.  **Run a model**: Open your terminal and type `ollama run llama3`.
3.  **Chat**: The model will download (~4.7GB) and start an interactive chat session immediately.

## Key Terminology

-   **Quantization**: Compressing models to fit in VRAM. (See [Model Quantization](/knowledge/quantization))
-   **VRAM**: Video RAM on your GPU; the most important hardware metric. (See [VRAM Requirements](/knowledge/vram))
-   **Context Window**: How much "memory" the model has of the current chat.

## Related Concepts

-   [Ollama Guide](/knowledge/ollama) - Mastering the easiest local tool.
-   [GGUF Format](/knowledge/gguf) - The standard file format for local models.
-   [VRAM Requirements](/knowledge/vram) - Planning your hardware build.
-   [Quantization](/knowledge/quantization) - How models are compressed for local use.
