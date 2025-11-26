# Antigravity Agent Initialization Package

This package ensures that every time you restart Antigravity or switch LLM models,
the agent automatically loads and understands your project context.

## Included
- system_prompt.md
- project_context.md
- root_plan.md
- instructions_for_agent.md

## Usage
Place the entire folder in the ROOT of your project:
```
your-project/
  antigravity_init/
    system_prompt.md
    project_context.md
    root_plan.md
    instructions_for_agent.md
  src/
  ...
```

Then paste this into the first message to the agent:

```
Please load all files in antigravity_init/.  
Use them as permanent context for all future actions.
Acknowledge once loaded.
```

