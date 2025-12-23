---
description: how to run CES compliance check before committing
---

# CES Compliance Verification Workflow

## IMPORTANT: Use Python CES Check ONLY

**DO NOT use `ces-check.cjs` (deprecated/deleted)**

### Correct Command
```bash
python scripts/check_compliance.py
```

This checks:
1. **Art 5.1 Monolith Ban**: Files > 250 lines
2. **Art 5.1 Security**: D1 tokens, JWT, API keys
3. **Art 8.1 English Mandate**: CJK characters blocked
4. **Art 9.1 Confidentiality**: Forbidden file patterns

### NPM Script
```bash
npm run ces-check
```

### When to Run
- Before every commit
- After adding new files
- After refactoring
