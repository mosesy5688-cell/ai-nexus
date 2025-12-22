---
layout: ../../layouts/KnowledgeLayout.astro
title: Fine-Tuning Guide
slug: fine-tuning
---

# Fine-Tuning Guide

Fine-tuning adapts a pre-trained model to your specific use case using custom training data.

## Fine-Tuning Methods

| Method | VRAM Required | Quality | Speed |
|--------|---------------|---------|-------|
| Full Fine-Tuning | 80GB+ | Highest | Slow |
| LoRA | 16-24GB | Very Good | Fast |
| QLoRA | 8-16GB | Good | Fast |
| Prefix Tuning | 8GB | Medium | Fastest |

## When to Fine-Tune

✅ **Good candidates:**
- Custom domains (medical, legal, technical)
- Specific writing styles
- Task-specific optimization

❌ **Not recommended:**
- General knowledge tasks
- Small datasets (<100 examples)
- Rapidly changing information

## Quick Start with LoRA

```bash
# Using Hugging Face PEFT
pip install peft transformers
```

## Training Data Requirements

| Dataset Size | Use Case |
|--------------|----------|
| 100-1K samples | Style adaptation |
| 1K-10K samples | Domain expertise |
| 10K+ samples | New capabilities |

## Related

- [VRAM Requirements](/knowledge/vram)
- [Model Quantization](/knowledge/quantization)
