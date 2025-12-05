# ArXiv Academic Enrichment - Runbook

**Version**: 1.0  
**Last Updated**: 2025-12-04  
**Owner**: Project Maintainer

---

## 📋 Overview

This runbook provides step-by-step instructions for enriching AI models with academic metadata from ArXiv repository.

### What This Does
- Extracts ArXiv IDs from model source_url or description
- Fetches paper metadata from ArXiv API
- Stores academic information (category, publish date) in D1
- Displays academic credentials on model detail pages

### Prerequisites
- ✅ Node.js 20+ with npm
- ✅ Wrangler CLI configured
- ✅ Cloudflare D1 database (ai-nexus-db)
- ✅ npm package: xml2js (installed)
- ✅ No API key needed (ArXiv is free)

---

## 🗄️ Database Migration

### 1. Apply Migration (Development)

Test migration locally first:

```bash
cd G:\ai-nexus

# Apply migration
npx wrangler d1 execute ai-nexus-db --local --file=migrations/0013_add_arxiv_fields.sql

# Verify migration
npx wrangler d1 execute ai-nexus-db --local --file=migrations/0013_verify.sql
```

**Expected Output**:
```
✅ Migration applied successfully
4 columns added: arxiv_id, arxiv_category, arxiv_published, arxiv_updated
2 indexes created
```

### 2. Apply Migration (Production)

After local testing passes:

```bash
# Backup first (optional but recommended)
npx wrangler d1 backup create ai-nexus-db

# Apply migration to production
npx wrangler d1 execute ai-nexus-db --remote --file=migrations/0013_add_arxiv_fields.sql

# Verify production migration
npx wrangler d1 execute ai-nexus-db --remote --file=migrations/0013_verify.sql
```

**Verify Columns**:
```sql
PRAGMA table_info(models);
-- Should show: arxiv_id, arxiv_category, arxiv_published, arxiv_updated
```

---

## 🎓 Enrichment Process

### Step 1: Dry Run (Recommended First Step)

Test the enrichment process without writing to database:

```bash
# Test with 3 models
node scripts/enrich-arxiv.js --dry-run --limit=3
```

**Expected Output**:
```
🎓 ArXiv Academic Enrichment
Mode: LOCAL (Development)
Dry Run: YES (no database writes)
Limit: 3

Processing: Model Name
✅ ArXiv ID: 2301.12345
📁 Category: cs.AI
📅 Published: 1/30/2023
[DRY RUN] Would update model abc123
```

### Step 2: Local Enrichment (Small Batch)

Enrich a small batch locally to verify:

```bash
# Enrich 10 models locally
node scripts/enrich-arxiv.js --local --limit=10
```

**Monitor Output**:
- ✅ Successfully enriched: X
- ⏭️ Skipped (no ArXiv data): Y
- ❌ Failed: Z (should be 0)

### Step 3: Production Enrichment (Batch)

Start with a small production batch:

```bash
# Enrich 50 models in production
node scripts/enrich-arxiv.js --remote --limit=50
```

**Rate Limiting**: ArXiv has NO rate limits, but we use delays for stability:
- 500ms between models
- 2000ms between batches (10 models)

### Step 4: Full Production Run

After verifying batches work correctly:

```bash
# Enrich ALL models with ArXiv references
node scripts/enrich-arxiv.js --remote
```

**Estimated Time**:
- ~300-400 models total
- ~0.5s per model
- Total: ~3-4 minutes

---

## 📊 Verification

### Check Enrichment Status

```bash
npx wrangler d1 execute ai-nexus-db --remote --file=migrations/0013_verify.sql
```

**Expected Metrics**:
```
total_models: 2016
with_arxiv_id: 300-400
enriched: 300-400
enrichment_pct: 15-20%
```

### Check Sample Records

```sql
SELECT id, name, arxiv_id, arxiv_category, arxiv_published
FROM models 
WHERE arxiv_id IS NOT NULL 
LIMIT 5;
```

### Verify Frontend Display

1. Build and deploy frontend:
   ```bash
   npm run build
   git add -A
   git commit -m "feat: Add ArXiv academic metadata (Task 7)"
   git push origin main
   ```

2. Visit enriched model page (example):
   ```
   https://free2aitools.com/model/[model-slug]
   ```

3. Verify ArXiv section displays:
   - ✅ ArXiv Paper link (purple)
   - ✅ Category badge
   - ✅ Publication date

---

## 🔧 Troubleshooting

### Issue 1: "xml2js not found"

**Symptom**:
```
Error: Cannot find module 'xml2js'
```

**Fix**:
```bash
npm install xml2js
```

### Issue 2: No models found for enrichment

**Symptom**:
```
Found 0 models with potential ArXiv references
```

**Diagnosis**:
```sql
-- Check for models with arxiv.org URLs
SELECT COUNT(*) 
FROM models 
WHERE source_url LIKE '%arxiv.org%';
```

**Possible Causes**:
- Models already enriched (arxiv_id not NULL)
- No models have ArXiv references in source_url or description
- Database connection issue

**Fix**: Verify data exists, check --remote vs --local flag

### Issue 3: ArXiv API timeout

**Symptom**:
```
Retry 1/3 for 2301.12345 in 2000ms
Failed to fetch ArXiv metadata after 3 attempts
```

**Diagnosis**:
- Network connectivity issue
- ArXiv API temporarily unavailable
- Invalid ArXiv ID

**Fix**:
- Wait and retry
- Script has automatic retry logic (3 attempts, exponential backoff)
- Check ArXiv ID format: `2301.12345` or `cs/0601001`

### Issue 4: XML parsing error

**Symptom**:
```
Error: Non-whitespace before first tag.
```

**Diagnosis**:
- ArXiv API returned non-XML response
- Network error corrupted response

**Fix**:
- Look at actual error message in logs
- Retry the script
- If persistent, check ArXiv API status: https://status.arxiv.org

### Issue 5: Frontend not showing ArXiv data

**Symptom**:
- Database has arxiv_id
- Frontend doesn't display ArXiv section

**Diagnosis**:
```javascript
// Check ModelInfoTable.astro condition
{model.arxiv_id && (...)}
```

**Fix**:
- Clear browser cache
- Rebuild frontend: `npm run build`
- Verify model data: `console.log(model.arxiv_id)`

---

## 🔄 Rollback Procedure

If enrichment causes issues:

### 1. Rollback Database Changes

```bash
# Run rollback migration
npx wrangler d1 execute ai-nexus-db --remote --file=migrations/0013_rollback.sql

# Verify rollback
npx wrangler d1 execute ai-nexus-db --remote --command="PRAGMA table_info(models)"
# Should NOT show arxiv_* columns
```

### 2. Rollback Code Changes

```bash
git revert [commit-hash]
git push origin main
```

### 3 Verify Rollback

- Database: No arxiv_* columns
- Frontend: No ArXiv section displayed
- No errors in build

---

## 📈 Monitoring

### Daily Checks

```sql
-- Check enrichment growth
SELECT 
  DATE(arxiv_updated) as date,
  COUNT(*) as enriched_count
FROM models
WHERE arxiv_id IS NOT NULL
GROUP BY DATE(arxiv_updated)
ORDER BY date DESC
LIMIT 7;
```

### Monthly Reports

```sql
-- Category distribution
SELECT 
arxiv_category,
  COUNT(*) as count,
  ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM models WHERE arxiv_id IS NOT NULL), 2) as pct
FROM models
WHERE arxiv_category IS NOT NULL
GROUP BY arxiv_category
ORDER BY count DESC
LIMIT 10;
```

---

## 🚀 Automation (Optional)

### GitHub Actions Workflow

Create `.github/workflows/arxiv-enrichment.yml`:

```yaml
name: Weekly ArXiv Enrichment

on:
  schedule:
    - cron: '0 2 * * 0'  # Every Sunday at 2 AM UTC
  workflow_dispatch:

jobs:
  enrich:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - run: npm ci
      
      - name: Run ArXiv Enrichment
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: node scripts/enrich-arxiv.js --remote --limit=100
```

---

## 📚 Reference

### ArXiv API Documentation
- API Manual: https://info.arxiv.org/help/api/user-manual.html
- Rate Limits: None (unlimited)
- Response Format: Atom XML

### ArXiv ID Formats
- New format: `2301.12345` (YYMM.NNNNN)
- Old format: `cs/0601001` (archive/YYMMNNN)

### Related Files
- Migration: `migrations/0013_add_arxiv_fields.sql`
- Rollback: `migrations/0013_rollback.sql`
- Verify: `migrations/0013_verify.sql`
- Adapter: `src/lib/adapters/arxiv-enricher.js`
- Script: `scripts/enrich-arxiv.js`
- UI: `src/components/ModelInfoTable.astro`

---

## 🆘 Support

**Issues**: Check `TECHNICAL_DEBT_UPDATE.md` for known issues  
**Questions**: Review implementation plan in artifacts  
**Errors**: Enable verbose logging in scripts

---

**Last Updated**: 2025-12-04  
**Status**: ✅ Ready for Production
