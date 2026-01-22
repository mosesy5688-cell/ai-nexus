---
title: What is Function Calling?
description: Enabling LLMs to interact with external tools and APIs through structured function definitions
keywords: function calling, tool use, api integration, agents, structured output
---

# What is Function Calling?

**Function Calling** (also called Tool Use) allows language models to request execution of predefined functions with structured arguments. Instead of generating text responses, the model outputs structured function calls that your code can execute.

## How It Works

1. **Define Functions**: Describe available tools with names, descriptions, and parameter schemas
2. **User Query**: Send user message with function definitions
3. **Model Response**: Model returns function name + arguments (not the result!)
4. **Execute**: Your code runs the function
5. **Return Result**: Send result back to model for final response

## Example Flow

```
User: "What's the weather in Tokyo?"
    ↓
Model: {"function": "get_weather", "args": {"location": "Tokyo"}}
    ↓
Your Code: calls real weather API → "25°C, sunny"
    ↓
Model: "The weather in Tokyo is 25°C and sunny."
```

## Defining Functions

```python
functions = [{
    "name": "get_weather",
    "description": "Get current weather for a location",
    "parameters": {
        "type": "object",
        "properties": {
            "location": {
                "type": "string",
                "description": "City name"
            },
            "unit": {
                "type": "string",
                "enum": ["celsius", "fahrenheit"]
            }
        },
        "required": ["location"]
    }
}]
```

## Common Use Cases

| Use Case | Example Functions |
|----------|-------------------|
| **Data Retrieval** | search_database, get_user_info |
| **Actions** | send_email, create_ticket |
| **Calculations** | calculate_price, convert_currency |
| **External APIs** | get_weather, search_web |

## Provider Comparison

| Provider | Feature Name | Multiple Calls |
|----------|--------------|----------------|
| OpenAI | Function Calling / Tools | Yes (parallel) |
| Anthropic | Tool Use | Yes |
| Google | Function Calling | Yes |
| Open Source | Varies by model | Depends |

## Best Practices

1. **Clear descriptions**: Help model understand when to use each function
2. **Validate arguments**: Never trust model output blindly
3. **Handle errors**: Return useful error messages to model
4. **Limit scope**: Only expose necessary functions
5. **Test edge cases**: Model may call wrong function

## Parallel Function Calling

Modern APIs support multiple simultaneous calls:
```
User: "What's the weather in Tokyo and Paris?"
Model: [
    {"function": "get_weather", "args": {"location": "Tokyo"}},
    {"function": "get_weather", "args": {"location": "Paris"}}
]
```

## Related Concepts

- [Agents](/knowledge/agents) - Autonomous tool-using systems
- [Structured Output](/knowledge/structured-output) - Reliable data generation
- [RAG](/knowledge/rag) - Knowledge retrieval
