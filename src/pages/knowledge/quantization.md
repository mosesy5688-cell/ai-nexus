---
layout: ../../layouts/KnowledgeLayout.astro
title: What is Model Quantization?
slug: quantization
description: Techniques to compress large language models by reducing weight precision, enabling inference on consumer hardware
keywords: quantization, gguf, gptq, awq, exl2, bits per weight, model compression
---

# What is Model Quantization?

**Quantization** is the process of reducing the precision of an AI model's numerical weights (e.g., from 16-bit floating point to 4-bit integers). This essential technique dramatically reduces the memory (VRAM) required to run models and often speeds up inference, allowing massive models like Llama-70B to run on consumer-grade hardware.

## How It Works

Imagine a high-resolution photograph (16-bit). Quantization is like saving that photo as a high-quality JPEG (4-bit). You lose some subtle details, but the image is significantly smaller and much easier to share or open on older devices. In LLMs, we map a range of high-precision values to a smaller set of discrete "buckets."

## Common Quantization Formats

| Format | Primary Hardware | Best For... | Tools |
| :--- | :--- | :--- | :--- |
| **GGUF** | CPU / Apple Silicon | Local inference with llama.cpp | [Ollama](/knowledge/ollama), [GGUF](/knowledge/gguf) |
| **GPTQ** | NVIDIA GPU | Fast GPU-only inference | AutoGPTQ |
| **AWQ** | NVIDIA GPU | Best quality at 4-bit for GPUs | [AWQ](/knowledge/awq), vLLM |
| **EXL2** | NVIDIA GPU | Extreme flexibility (2.5bpw to 8bpw) | ExLlamaV2 |
| **GGUF (IQ)** | All Hardware | Recent "Importance Quantization" (lower bits) | llama.cpp |

## VRAM Impact (e.g., 7B Model)

| Precision | Bits/Weight | VRAM needed | Quality Loss |
| :--- | :--- | :--- | :--- |
| **FP16 (Native)** | 16 | ~15 GB | None |
| **Q8 (8-bit)** | 8 | ~8 GB | Negligible |
| **Q5 (5-bit)** | 5 | ~5 GB | Minimal |
| **Q4 (4-bit)** | 4 | ~4.5 GB | Slight (Standard) |
| **Q2 (2-bit)** | 2 | ~2.5 GB | Significant |

## When to Use Which Quant?

-   **Professional Use**: Use **8-bit (Q8)** or **6-bit (Q6)** if you have the memory. The quality is nearly identical to the original.
-   **Balanced (Recommended)**: Use **5-bit (Q5_K_M)** or **4-bit (Q4_K_M)**. This is the "sweet spot" for performance vs. size.
-   **Experimental**: Use **2-bit** or **3-bit** only if you are extremely memory-constrained. Expect coherent but significantly dumber output.

## Hardware Considerations

1.  **Mac M1/M2/M3**: Always prefer **GGUF**. macOS handles shared memory exceptionally well for these formats.
2.  **NVIDIA RTX 30/40 Series**: Prefer **AWQ** or **GPTQ** for pure speed, or **GGUF** if you want to swap between RAM and VRAM.
3.  **Cloud GPUs (H100/A100)**: Often run in **FP8** or **INT8** for maximum throughput.

## Related Concepts

-   [VRAM Requirements](/knowledge/vram) - How much memory you actually need.
-   [Local Inference](/knowledge/local-inference) - Running these models on your machine.
-   [GGUF Format](/knowledge/gguf) - The most popular local model format.
-   [AWQ Technique](/knowledge/awq) - Activation-aware Weight Quantization.
