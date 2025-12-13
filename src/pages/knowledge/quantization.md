---
layout: ../../layouts/KnowledgeLayout.astro
title: Model Quantization
slug: quantization
---

# Model Quantization

Quantization reduces model precision to lower memory usage and increase inference speed.

## Quantization Formats

| Format | Bits | Use Case | Tools |
|--------|------|----------|-------|
| **FP16** | 16 | Training | Native |
| **BF16** | 16 | Training | Native |
| **INT8** | 8 | Inference | TensorRT |
| **GPTQ** | 4 | GPU inference | AutoGPTQ |
| **AWQ** | 4 | GPU inference | AutoAWQ |
| **GGUF** | 2-8 | CPU/Apple M | llama.cpp |

## VRAM Savings

Approximate VRAM for a 7B parameter model:

| Precision | VRAM |
|-----------|------|
| FP32 | 28 GB |
| FP16 | 14 GB |
| INT8 | 7 GB |
| 4-bit | 4 GB |

## GGUF Quantization Levels

| Quant | Bits/Weight | Quality |
|-------|-------------|---------|
| Q8_0 | 8.5 | Best |
| Q6_K | 6.6 | Excellent |
| Q5_K_M | 5.7 | Great |
| Q4_K_M | 4.8 | Good |
| Q3_K_M | 3.9 | Acceptable |
| Q2_K | 2.6 | Lossy |

## When to Use

- **Q8**: Maximum quality, have VRAM
- **Q5_K_M**: Balanced (recommended)
- **Q4_K_M**: Memory constrained
- **Q2-Q3**: Extreme memory limits

## Related Concepts

- [VRAM Requirements](/knowledge/vram)
- [Local Inference](/knowledge/local-inference)
