---
layout: ../../layouts/KnowledgeLayout.astro
title: Ollama Guide
slug: ollama
description: The easiest way to get up and running with large language models locally on macOS, Linux, and Windows
keywords: ollama, local llm, llama 3, phi 3, modelfile, local ai
---

# What is Ollama?

**Ollama** is an open-source tool that allows you to run open-weight large language models (LLMs) locally with minimal setup. It packages model weights, configuration, and a server into a single easy-to-use interface, similar to how Docker works for applications.

## Why Use Ollama?

-   **One-Line Setup**: Install and run a model in seconds.
-   **GGUF Support**: Automatically handles [GGUF](/knowledge/gguf) quantization for efficient CPU/GPU usage.
-   **Local REST API**: Comes with a built-in API that developers can use to build their own local AI apps.
-   **Model Library**: Access to a curated list of models like Llama 3, Mistral, Phi-3, and Gemma.

## Essential CLI Commands

| Command | Action |
| :--- | :--- |
| `ollama run <model>` | Pull and start staying with a model (e.g., `llama3`) |
| `ollama list` | View all models installed on your machine |
| `ollama rm <model>` | Delete a model to free up space |
| `ollama pull <model>` | Download a model without running it |
| `ollama serve` | Start the local API server manually |

## Customizing Models (Modelfile)

One of Ollama's most powerful features is the **Modelfile**. You can create a specialized version of any model with custom system prompts:

```dockerfile
# Create a "Dolphin-Coder" model
FROM dolphin-llama3
PARAMETER temperature 0.1
SYSTEM "You are a professional Python engineer. Answer only in code."
```
*Run `ollama create my-coder -f Modelfile` to build it.*

## Popular Community UIs

While Ollama runs in the terminal, many people use beautiful web GUIs to talk to it:
-   **Open WebUI (formerly Ollama WebUI)**: The gold standard; looks and feels like ChatGPT.
-   **Page Assist**: a Chrome/Firefox extension that lets you use Ollama in your browser.
-   **Enchanted**: A popular macOS/iOS native client for Ollama.

## Performance Tips

1.  **VRAM vs RAM**: Ollama tries to load models into your GPU VRAM first. If it doesn't fit, it "offloads" layers to system RAM, which is much slower.
2.  **Flash Attention**: Newer versions of Ollama support Flash Attention, which can significantly speed up response times for long chats.
3.  **Concurrency**: You can set `OLLAMA_NUM_PARALLEL` to allow multiple concurrent requests to the same model.

## Related Concepts

-   [Local Inference Guide](/knowledge/local-inference) - The big picture of running AI locally.
-   [GGUF Format](/knowledge/gguf) - The technology behind Ollama's efficiency.
-   [Llama 3 Guide](/knowledge/llama) - The most popular model family on Ollama.
-   [VRAM Requirements](/knowledge/vram) - Planning your hardware for Ollama.
