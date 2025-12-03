# Branch Protection Rules Configuration

This document describes the required branch protection rules for the `main` branch.

## Required Settings

### General Protection Rules

- ✅ **Require a pull request before merging**
  - Require approvals: 0 (for solo developer) or 1 (for team)
  - Dismiss stale pull request approvals when new commits are pushed: ✅
  - Require review from Code Owners: ❌ (optional)

- ✅ **Require status checks to pass before merging**
  - Require branches to be up to date before merging: ✅
  - Required status checks:
    - `lint-and-build`
    - `smoke-tests`
    - `lighthouse` (optional, can allow failure)
    - `security-check` (optional, can allow failure)

- ✅ **Require conversation resolution before merging**: ✅

- ❌ **Require signed commits**: ❌ (optional for enhanced security)

- ❌ **Require linear history**: ❌ (allows merge commits)

- ✅ **Include administrators**: ✅ (rules apply to admins too)

- ❌ **Allow force pushes**: ❌ (prevents force push to main)

- ❌ **Allow deletions**: ❌ (prevents branch deletion)

---

## How to Configure

### Via GitHub Web UI

1. Go to: `https://github.com/YOUR_ORG/ai-nexus/settings/branches`
2. Click "Add branch protection rule"
3. Branch name pattern: `main`
4. Enable settings as listed above
5. Click "Create" or "Save changes"

### Via GitHub CLI

```bash
# Requires GitHub CLI (gh) installed and authenticated

gh api repos/YOUR_ORG/ai-nexus/branches/main/protection \
  --method PUT \
  --field required_status_checks='{"strict":true,"contexts":["lint-and-build","smoke-tests"]}' \
  --field enforce_admins=true \
  --field required_pull_request_reviews='{"dismiss_stale_reviews":true,"require_code_owner_reviews":false,"required_approving_review_count":0}' \
  --field restrictions=null \
  --field required_linear_history=false \
  --field allow_force_pushes=false \
  --field allow_deletions=false
```

### Via Terraform (Infrastructure as Code)

```hcl
resource "github_branch_protection" "main" {
  repository_id = "ai-nexus"
  pattern       = "main"

  required_status_checks {
    strict   = true
    contexts = ["lint-and-build", "smoke-tests"]
  }

  required_pull_request_reviews {
    dismiss_stale_reviews      = true
    require_code_owner_reviews = false
    required_approving_review_count = 0
  }

  enforce_admins = true

  allows_force_pushes = false
  allows_deletions    = false
}
```

---

## Verification

After configuring, verify protection is active:

```bash
# Check branch protection status
gh api repos/YOUR_ORG/ai-nexus/branches/main/protection

# Or via web UI
# Navigate to: Settings > Branches > main (should show "Protected")
```

---

## Emergency Override

In case of emergency (production down, critical hotfix needed):

### Option 1: Temporary Disable (Not Recommended)

1. Admin goes to branch protection settings
2. Temporarily disable "Include administrators"
3. Push urgent fix
4. Re-enable protection immediately

### Option 2: Emergency PR (Recommended)

1. Create PR with `[EMERGENCY]` prefix
2. Request immediate review (if required)
3. Merge after CI passes (ensure smoke tests run)
4. Post-incident review to prevent recurrence

---

## Monitoring & Alerts

### Failed Status Checks

When CI fails:
- PR cannot be merged (blocked by GitHub)
- Developer receives notification
- PR shows red X with failure details

### Bypass Attempts

GitHub audit log records:
- Branch protection rule changes
- Force push attempts (blocked)
- Admin overrides (if any)

**Review audit log**: Settings > Audit log

---

## Best Practices

### For Solo Developer

- **Required reviewers**: 0 (you can self-merge)
- **Status checks**: Required (prevents broken deployments)
- **Include admins**: Yes (enforce your own rules)

### For Team

- **Required reviewers**: 1+ (peer review)
- **Code owners**: Optional (auto-assign reviewers)
- **Conversation resolution**: Yes (ensure all feedback addressed)

### For Critical Projects

- **Signed commits**: Required
- **Linear history**: Required (rebase only)
- **Status checks**: All must pass (including Lighthouse)
- **Required reviewers**: 2+

---

## Troubleshooting

### "Required status check is missing"

**Cause**: Workflow hasn't run yet  
**Fix**: Push a commit or re-run workflow manually

### "Branch is not up to date"

**Cause**: `main` has new commits  
**Fix**: `git pull --rebase origin main` then push

### "CI checks failing"

**Cause**: Code doesn't pass lint/build/tests  
**Fix**: Check workflow logs, fix locally, push update

### "Cannot bypass protection rules"

**Cause**: Admin protection enabled  
**Fix**: This is correct behavior, follow proper PR process

---

## Related Documentation

- [GitHub Branch Protection Docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches)
- [CI Checks Workflow](../.github/workflows/ci-checks.yml)
- [Contributing Guide](../CONTRIBUTING.md) (create if needed)
