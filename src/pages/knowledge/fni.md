---
layout: ../../layouts/KnowledgeLayout.astro
title: What is FNI Score?
slug: fni
---

# What is FNI Score?

FNI (Free2AITools Normalized Index) is a composite score measuring model quality across four dimensions: Performance, Versatility, Community, and Usability.

## Score Components

| Component | Weight | Measures |
|-----------|--------|----------|
| **P** - Performance | 30% | Benchmark scores (MMLU, HumanEval) |
| **V** - Versatility | 25% | Task coverage, multi-modality |
| **C** - Community | 25% | Downloads, likes, citations |
| **U** - Usability | 20% | Deploy score, GGUF availability |

## Score Range

| FNI Score | Percentile | Quality |
|-----------|------------|---------|
| 90+ | Top 1% | Exceptional |
| 80-89 | Top 5% | Excellent |
| 70-79 | Top 15% | Very Good |
| 60-69 | Top 30% | Good |
| 50-59 | Top 50% | Average |
| <50 | Bottom 50% | Below Average |

## How to Use FNI

1. **Compare models** - Higher FNI = better overall quality
2. **Filter by component** - Focus on P for benchmarks, U for ease of use
3. **Track trends** - Rising FNI indicates community adoption

## Related

- [VRAM Requirements](/knowledge/vram)
- [Model Quantization](/knowledge/quantization)
