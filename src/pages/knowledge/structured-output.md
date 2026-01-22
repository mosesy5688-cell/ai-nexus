---
layout: ../../layouts/KnowledgeLayout.astro
title: What is Structured Output?
slug: structured-output
description: Techniques for generating reliable JSON, code, and formatted data from LLMs
keywords: structured output, json mode, function calling, grammar, constrained decoding
---

# What is Structured Output?

**Structured Output** refers to techniques for making language models generate reliable, parseable data formats like JSON, XML, or code that follows specific schemas. This is essential for building reliable AI applications.

## The Challenge

LLMs are trained on free-form text and may:
- Output invalid JSON (missing brackets, trailing commas)
- Include explanatory text mixed with data
- Deviate from required schemas
- Hallucinate field names

## Solution Approaches

### 1. JSON Mode
API-level guarantee of valid JSON output.
```python
response = client.chat.completions.create(
    model="gpt-4",
    response_format={"type": "json_object"},
    messages=[...]
)
```

### 2. Function Calling / Tool Use
Define schemas, get structured responses.
```python
tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "parameters": {
            "type": "object",
            "properties": {
                "location": {"type": "string"},
                "unit": {"enum": ["celsius", "fahrenheit"]}
            }
        }
    }
}]
```

### 3. Grammar-Constrained Decoding
Enforce output grammar at the token level.
- **Outlines**: Python library for constrained generation
- **llama.cpp**: GBNF grammar support
- **vLLM**: Guided decoding

### 4. Pydantic / JSON Schema
Define schemas that validate outputs.
```python
from pydantic import BaseModel

class Person(BaseModel):
    name: str
    age: int
    email: str
```

## Comparison

| Method | Reliability | Flexibility | Speed |
|--------|-------------|-------------|-------|
| JSON Mode | High | Low | Fast |
| Function Calling | Very High | Medium | Fast |
| Grammar Constrained | Perfect | High | Slower |
| Post-processing | Variable | High | Fast |

## Best Practices

1. **Be explicit**: Include schema in prompt
2. **Use examples**: Show expected format
3. **Validate**: Always parse and validate output
4. **Retry logic**: Handle malformed responses
5. **Temperature**: Lower values for more reliable output

## Tools & Libraries

| Tool | Use Case |
|------|----------|
| **Instructor** | Pydantic + LLM integration |
| **Outlines** | Grammar-constrained generation |
| **Marvin** | AI functions with types |
| **LangChain** | Output parsers |

## Related Concepts

- [Prompt Engineering](/knowledge/prompt-engineering) - Crafting effective prompts
- [Agents](/knowledge/agents) - Structured tool use
- [RAG](/knowledge/rag) - Structured retrieval
