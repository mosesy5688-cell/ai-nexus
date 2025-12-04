# GitHub Data Enrichment Runbook

## Overview

This runbook describes the process for enriching AI model records with GitHub repository statistics.

**Purpose**: Automatically fetch and update GitHub statistics (stars, forks, last commit) for models hosted on GitHub.

**Frequency**: On-demand or scheduled (e.g., weekly)

**Duration**: Varies by number of models (approximately 1 model per second due to rate limiting)

---

## Prerequisites

### 1. GitHub Personal Access Token

You need a GitHub Personal Access Token to avoid rate limiting:

1. Go to https://github.com/settings/tokens
2. Click "Generate new token" → "Generate new token (classic)"
3. Give it a descriptive name: `AI-Nexus Enrichment`
4. Select scopes: `public_repo` (read access to public repositories)
5. Generate and copy the token

### 2. Configure Environment

Add to `.env` file:

```bash
GITHUB_TOKEN=ghp_your_personal_access_token_here
```

**⚠️ Security**: Never commit this token to version control!

---

## Migration Setup

### Step 1: Run Database Migration

```bash
# Test on local D1 first
npx wrangler d1 execute ai-nexus-db --local --file=migrations/0012_add_github_fields.sql

# Verify migration succeeded
npx wrangler d1 execute ai-nexus-db --local --file=migrations/0012_verify.sql

# Apply to production
npx wrangler d1 execute ai-nexus-db --remote --file=migrations/0012_add_github_fields.sql
```

### Step 2: Verify Schema

```bash
npx wrangler d1 execute ai-nexus-db --remote --command="PRAGMA table_info(models)"
```

Expected output should include:
- `github_stars INTEGER`
- `github_forks INTEGER` 
- `github_last_commit TEXT`
- `github_contributors INTEGER`

---

## Running Enrichment

### Dry Run (Recommended First)

```bash
# Test what would happen without making changes
node scripts/enrich-github.js --dry-run --limit=10
```

This will:
- Show which models would be updated
- Display GitHub statistics that would be saved
- NOT modify the database

### Local Database Enrichment

```bash
# Enrich local D1 database (for testing)
node scripts/enrich-github.js --local --limit=50
```

### Production Enrichment

```bash
# Enrich first 100 models
node scripts/enrich-github.js --remote --limit=100

# Enrich all models (can take hours!)
node scripts/enrich-github.js --remote
```

---

## Monitoring

### Check Rate Limit

The script automatically checks and displays your GitHub API rate limit:

```
✅ Rate limit: 4823/5000 remaining
   Resets at: 12/4/2025, 5:00:00 AM
```

**Limits**:
- **Unauthenticated**: 60 requests/hour
- **Authenticated**: 5,000 requests/hour

### Check Progress

The script provides real-time progress:

```
📦 Processing batch 1/10 (10 models)...
📊 Enriching meta-llama/Llama-2-7b with GitHub data for meta-llama/Llama-2-7b...
✅ Updated meta-llama/Llama-2-7b: 12,345⭐ 2,678🔀
```

### Final Summary

```
====================================================================
📊 ENRICHMENT SUMMARY
====================================================================
✅ Success: 95
❌ Failed:  3
⏭️  Skipped: 2
📝 Total:   100
====================================================================
```

---

## Troubleshooting

### Rate Limit Exceeded

**Symptom**: 
```
⏳ GitHub rate limit exceeded. Waiting 3600s...
```

**Solution**:
- Wait for rate limit reset (shown in message)
- OR use a GitHub token with higher limits
- OR run enrichment in smaller batches

### Repository Not Found (404)

**Symptom**:
```
⚠️  Repository not found: owner/repo
```

**Possible causes**:
- Repository was deleted
- Repository is now private
- URL in database is incorrect

**Action**: These are automatically skipped (counted in "Failed")

### Connection Timeouts

**Symptom**:
```
❌ Failed to fetch owner/repo after 3 attempts: timeout of 10000ms exceeded
```

**Solution**:
- Check internet connection
- GitHub API might be experiencing issues
- Re-run the script (already-enriched models will be skipped)

---

## Rollback

If you need to remove the GitHub fields:

```bash
# Local rollback
npx wrangler d1 execute ai-nexus-db --local --file=migrations/0012_rollback.sql

# Production rollback
npx wrangler d1 execute ai-nexus-db --remote --file=migrations/0012_rollback.sql
```

⚠️ **Warning**: This will permanently delete all GitHub statistics data!

---

## Automation (Optional)

### GitHub Actions Workflow

Create `.github/workflows/enrich-github.yml`:

```yaml
name: Weekly GitHub Enrichment

on:
  schedule:
    - cron: '0 2 * * 0'  # Every Sunday at 2 AM
  workflow_dispatch:  # Manual trigger

jobs:
  enrich:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - run: npm ci
      
      - name: Run Enrichment
        env:
          GITHUB_TOKEN: ${{ secrets.ENRICHMENT_GITHUB_TOKEN }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: |
          node scripts/enrich-github.js --remote --limit=500
```

---

## Verification

### Frontend Display

After enrichment, visit model detail pages to verify GitHub stats are displayed:

1. Navigate to a model with GitHub source: `/model/[slug]`
2. Scroll to "Model Information" table
3. Check for "GitHub Statistics" section showing:
   - ⭐ GitHub Stars
   - 🔀 GitHub Forks
   - 📝 Last Commit

### Database Query

```bash
npx wrangler d1 execute ai-nexus-db --remote --command="
  SELECT 
    id, 
    name, 
    github_stars, 
    github_forks
  FROM models 
  WHERE github_stars > 0 
  ORDER BY github_stars DESC 
  LIMIT 10
"
```

---

## Best Practices

1. **Always run dry-run first** to see what will be changed
2. **Test on local D1** before production
3. **Use --limit** for initial runs to verify everything works
4. **Monitor rate limits** to avoid API throttling
5. **Schedule during low-traffic hours** (e.g., 2-4 AM)
6. **Keep logs** of enrichment runs for debugging

---

## Support

For issues or questions:
- Check GitHub API status: https://www.githubstatus.com/
- Review script logs for error details
- Verify `.env` configuration
- Test with `--dry-run` flag first
