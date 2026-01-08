# CES Compliance Check Workflow

Run this workflow before every commit to ensure Constitutional compliance.

## Steps

// turbo-all

1. Run local CES check:
```bash
npm run ces-check
```

2. If violations are found, fix them:
   - **Art 5.1 Monolith Ban**: File > 250 lines → Split into modules
   - **Art 12 Cost Ceiling**: Check for expensive operations
   - **Art 13.4 Non-Destructive**: No data deletion without backup

3. After fixes, run CES check again to verify compliance.

4. Commit and push only when CES check passes.

## Common Violations

| Article | Violation | Fix |
|---------|-----------|-----|
| Art 5.1 | File > 250 lines | Split into lib/ modules |
| Art 2.2 | Raw data in R2 | Use processed data only |
| Art 13.4 | Destructive ops | Add versioning/backup |

## Auto-Fix Commands

```bash
# Check file lengths
find scripts -name "*.js" -exec wc -l {} \; | awk '$1 > 250 {print}'
```
