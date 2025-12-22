---
layout: ../../layouts/KnowledgeLayout.astro
title: Understanding Context Length
slug: context-length
---

# Understanding Context Length

Context length is the maximum number of tokens a model can process in a single input/output cycle. Longer context enables handling larger documents.

## Common Context Lengths

| Model | Context Length |
|-------|---------------|
| GPT-4 Turbo | 128K tokens |
| Claude 3 | 200K tokens |
| Llama 3 | 8K tokens |
| Mistral | 32K tokens |
| Gemini 1.5 | 1M tokens |

## Token Estimation

| Content Type | ~Tokens |
|--------------|---------|
| 1 page of text | 500 |
| 10 page document | 5,000 |
| Average book | 80,000 |
| Codebase (10K lines) | 40,000 |

## Use Cases by Context Length

| Length | Best For |
|--------|----------|
| 4K | Chat, simple Q&A |
| 32K | Long documents, code review |
| 128K+ | Books, large codebases |

## Tips

1. **Chunk large inputs** for models with limited context
2. **Use RAG** for knowledge beyond context window
3. **Consider cost** - longer context often means higher price

## Related

- [VRAM Requirements](/knowledge/vram)
- [What is GGUF?](/knowledge/gguf)
