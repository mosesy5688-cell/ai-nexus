---
layout: ../../layouts/KnowledgeLayout.astro
title: HuggingFace Hub Guide
slug: huggingface
---

# HuggingFace Hub Guide

HuggingFace Hub is the largest repository for open-source AI models with 500K+ models.

## Model Card Fields

| Field | Description |
|-------|-------------|
| `pipeline_tag` | Primary task (text-generation, etc.) |
| `library_name` | Framework (transformers, diffusers) |
| `license` | Usage rights |
| `downloads` | 30-day download count |
| `likes` | Community endorsements |

## Loading Models

```python
from transformers import AutoModelForCausalLM, AutoTokenizer

model = AutoModelForCausalLM.from_pretrained("meta-llama/Llama-2-7b")
tokenizer = AutoTokenizer.from_pretrained("meta-llama/Llama-2-7b")
```

## Model Naming Convention

```
{organization}/{model-name}-{size}-{variant}

Examples:
- meta-llama/Llama-2-7b-chat-hf
- TheBloke/Llama-2-7B-GGUF
- mistralai/Mistral-7B-Instruct-v0.2
```

## Gated Models

Some models require:
1. Create HuggingFace account
2. Accept license agreement
3. Use access token

## Related

- [GGUF Format](/knowledge/gguf)
- [Model Quantization](/knowledge/quantization)
