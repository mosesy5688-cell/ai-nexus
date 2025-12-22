---
layout: ../../layouts/KnowledgeLayout.astro
title: LLM Benchmarks Explained
slug: llm-benchmarks
---

# LLM Benchmarks Explained

Benchmarks measure LLM capabilities across different tasks. Understanding them helps choose the right model.

## Key Benchmarks

| Benchmark | Tests | Range |
|-----------|-------|-------|
| **MMLU** | Academic knowledge | 0-100% |
| **HumanEval** | Code generation | 0-100% |
| **HellaSwag** | Commonsense reasoning | 0-100% |
| **ARC-Challenge** | Science questions | 0-100% |
| **GSM8K** | Math word problems | 0-100% |
| **TruthfulQA** | Factual accuracy | 0-100% |

## Leaderboard Rankings

| Tier | MMLU | HumanEval |
|------|------|-----------|
| Top | 85%+ | 80%+ |
| Excellent | 75-84% | 60-79% |
| Good | 65-74% | 40-59% |
| Average | 50-64% | 20-39% |

## Benchmark Limitations

1. **Overfitting** - Models may train on test data
2. **Task-specific** - High benchmark ≠ good at everything
3. **Dated** - New capabilities may not be measured

## Related

- [What is FNI?](/knowledge/fni)
- [Context Length](/knowledge/context-length)
