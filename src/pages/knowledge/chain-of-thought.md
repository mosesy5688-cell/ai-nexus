---
layout: ../../layouts/KnowledgeLayout.astro
title: What is Chain of Thought?
slug: chain-of-thought
description: Prompting technique that improves reasoning by encouraging step-by-step thinking
keywords: chain of thought, cot, reasoning, prompting, zero-shot cot, few-shot
---

# What is Chain of Thought?

**Chain of Thought (CoT)** is a prompting technique that significantly improves language model reasoning by encouraging models to break down complex problems into intermediate steps before arriving at a final answer.

## The Key Insight

Instead of asking for a direct answer:
```
Q: What is 23 × 17?
A: 391
```

CoT prompts for reasoning:
```
Q: What is 23 × 17?
A: Let me break this down:
   23 × 17 = 23 × (10 + 7)
   = 23 × 10 + 23 × 7
   = 230 + 161
   = 391
```

## Types of Chain of Thought

### 1. Few-Shot CoT
Provide examples with reasoning steps before the actual question.

### 2. Zero-Shot CoT
Simply add "Let's think step by step" to the prompt.
- Discovered to improve reasoning without examples
- Works across many task types

### 3. Self-Consistency
Generate multiple reasoning chains, select the most common answer.
- Improves accuracy by ~10-20%
- Higher compute cost

### 4. Tree of Thoughts
Explore multiple reasoning branches, evaluate and prune.
- Best for complex, multi-step problems
- Significantly higher compute cost

## When CoT Helps

| Task Type | Improvement |
|-----------|-------------|
| Math problems | Very High |
| Multi-step logic | High |
| Common sense reasoning | Medium |
| Simple factual recall | None/Negative |

## Best Practices

1. **Use for complex tasks**: Simple tasks may get worse
2. **Be explicit**: "Think step by step" or "Show your reasoning"
3. **Provide format**: Show what good reasoning looks like
4. **Consider self-consistency**: For important decisions

## CoT in Modern Models

Many recent models are trained with CoT data:
- **GPT-4**: Extensive reasoning training
- **Claude**: Constitutional AI + reasoning
- **LLaMA 2**: Improved reasoning capabilities
- **Gemini**: Multi-step reasoning focus

## Limitations

- ❌ Increases token usage (cost)
- ❌ Slower inference
- ❌ Can produce plausible but wrong reasoning
- ❌ Not helpful for simple tasks

## Related Concepts

- [Prompt Engineering](/knowledge/prompt-engineering) - General prompting techniques
- [RAG](/knowledge/rag) - Retrieval-augmented generation
- [Agents](/knowledge/agents) - Autonomous reasoning systems
