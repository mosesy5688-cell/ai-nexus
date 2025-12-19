---
description: Coding workflow - check for reusable modules before creating new ones
---

# Reuse-First Coding Workflow

Before creating any new module, adapter, component, or utility:

## Step 1: Search for Existing Implementations

```bash
# Search for similar patterns
grep -r "class.*Adapter" scripts/ingestion/adapters/
grep -r "function.*normalize" src/utils/
```

Or use file search:
- `find_by_name` for file patterns
- `grep_search` for code patterns

## Step 2: Evaluate Reusability

Ask these questions:
1. Is there an existing module that does 70%+ of what I need?
2. Can I add a parameter/method to extend existing code?
3. Is this a new data source, or a variation of an existing one?

## Step 3: Decision Matrix

| Finding | Action |
|---------|--------|
| Exact match exists | Use directly |
| 70%+ overlap | Extend existing module |
| <70% overlap | Create new, but extract shared logic |
| No match | Create new module |

## Step 4: If Extending Existing Module

1. Add new method to existing class/module
2. Parameterize differences (e.g., `entityType`, `apiEndpoint`)
3. Keep file under 250 lines (split if needed)

## Step 5: If Creating New Module

1. Check if shared utilities exist in:
   - `src/utils/`
   - `scripts/ingestion/adapters/base-adapter.js`
   - `workers/unified-workflow/src/utils/`
2. Import and use shared utilities
3. Document what was reused vs created
