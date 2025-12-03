# Alert System Configuration Guide

## Overview

The alert system monitors critical workflows and sends notifications when failures occur.

## Monitored Workflows

- ✅ **Weekly Database Backup** (CRITICAL)
- ✅ **Deploy to Cloudflare Pages** (HIGH)

## Notification Channels

### 1. Slack (Recommended)

**Setup:**

1. Create Slack webhook:
   - Go to: https://api.slack.com/apps
   - Create new app → Incoming Webhooks
   - Activate and create webhook URL

2. Add to GitHub:
   ```bash
   gh variable set SLACK_WEBHOOK_URL --body "https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
   ```

**Features:**
- Rich formatted messages
- Severity-based colors
- Quick action buttons
- Channel mentions (@channel for critical)

### 2. Email (Optional)

**Setup:**

1. Use Gmail SMTP:
   - Enable 2FA on Google account
   - Generate app password: https://myaccount.google.com/apppasswords

2. Add secrets to GitHub:
   ```bash
   gh secret set EMAIL_USERNAME --body "your-email@gmail.com"
   gh secret set EMAIL_PASSWORD --body "your-app-password"
   gh variable set NOTIFICATION_EMAIL --body "alerts@yourcompany.com"
   ```

**Features:**
- HTML formatted emails
- Severity-based styling
- Direct links to logs
- Professional formatting

### 3. GitHub Issues (Critical Only)

Automatically creates GitHub issue for CRITICAL failures.

**Features:**
- Auto-labeled
- Mentions triggering actor
- Includes checklist
- Direct log links

---

## Severity Levels

### 🚨 CRITICAL
- **Triggers**: Backup failures
- **Actions**: Slack + Email + GitHub Issue
- **Response Time**: Immediate
- **Examples**: Database backup failed

### ⚠️ HIGH
- **Triggers**: Deploy failures
- **Actions**: Slack + Email
- **Response Time**: < 1 hour
- **Examples**: Cloudflare Pages deploy failed

### ⚡ MEDIUM
- **Triggers**: Other workflow failures
- **Actions**: Slack
- **Response Time**: < 4 hours
- **Examples**: CI checks failed

---

## Configuration

### GitHub Variables (Public)

```bash
# Slack webhook URL
gh variable set SLACK_WEBHOOK_URL --body "https://hooks.slack.com/..."

# Email recipient
gh variable set NOTIFICATION_EMAIL --body "alerts@example.com"
```

### GitHub Secrets (Private)

```bash
# Email SMTP credentials
gh secret set EMAIL_USERNAME --body "your-email@gmail.com"
gh secret set EMAIL_PASSWORD --body "your-app-password"
```

### Verify Configuration

```bash
# List variables
gh variable list

# List secrets (names only)
gh secret list
```

---

## Testing Alerts

### Manual Test

1. Trigger workflow manually:
   ```bash
   gh workflow run alert-on-failure.yml
   ```

2. Or simulate failure:
   - Go to Actions
   - Find a completed backup workflow
   - Click "Re-run failed jobs"

### Expected Behavior

✅ Slack message received  
✅ Email received (if configured)  
✅ GitHub issue created (if CRITICAL)  
✅ Alert summary in workflow run

---

## Notification Examples

### Slack Message

```
🚨 Workflow Failed: Weekly Database Backup

Workflow:     Weekly Database Backup
Severity:     CRITICAL
Branch:       main
Triggered By: username
Time:         2025-12-03T14:30:00Z
Commit:       abc1234

@channel Action required!

[View Logs] [View Repository]
```

### Email

- **Subject**: 🚨 Workflow Failed: Weekly Database Backup
- **Content**: Formatted HTML with all details
- **Styling**: Red border for CRITICAL, orange for HIGH

### GitHub Issue

- **Title**: 🚨 CRITICAL: Weekly Database Backup Failed
- **Labels**: critical, automated-alert, workflow-failure
- **Body**: Full details + checklist

---

## Troubleshooting

### Slack Not Receiving

**Check:**
1. Webhook URL correct?
   ```bash
   gh variable list | grep SLACK
   ```
2. Webhook active in Slack app settings
3. Workflow logs for curl errors

**Fix:**
```bash
# Update webhook
gh variable set SLACK_WEBHOOK_URL --body "NEW_URL"
```

### Email Not Sending

**Check:**
1. Gmail app password correct
2. 2FA enabled on Google account
3. SMTP credentials in secrets

**Fix:**
```bash
# Regenerate app password
# Update secret
gh secret set EMAIL_PASSWORD --body "NEW_PASSWORD"
```

### No Alerts Received

**Check:**
1. Workflow file exists: `.github/workflows/alert-on-failure.yml`
2. Monitored workflow names match exactly
3. Failure actually occurred (check workflow status)

**Debug:**
```bash
# View alert workflow runs
gh run list --workflow=alert-on-failure.yml

# View specific run
gh run view RUN_ID
```

---

## Customization

### Add More Workflows to Monitor

Edit `alert-on-failure.yml`:

```yaml
on:
  workflow_run:
    workflows: 
      - "Weekly Database Backup"
      - "Deploy to Cloudflare Pages"
      - "Your New Workflow"  # Add here
    types: [completed]
```

### Adjust Severity Levels

Edit severity determination logic:

```yaml
- name: Determine Severity
  run: |
    if [[ "$WORKFLOW_NAME" == *"YourCriticalWorkflow"* ]]; then
      echo "level=CRITICAL" >> $GITHUB_OUTPUT
    fi
```

### Change Slack Message Format

Edit Slack notification step in `alert-on-failure.yml`.

Slack Block Kit Builder: https://app.slack.com/block-kit-builder

---

## Best Practices

### Response Procedures

1. **CRITICAL Alert**:
   - Drop everything
   - Check GitHub issue
   - Review logs immediately
   - Fix within 1 hour
   - Document in post-mortem

2. **HIGH Alert**:
   - Review within 1 hour
   - Check deployment status
   - Rollback if needed
   - Fix and redeploy

3. **MEDIUM Alert**:
   - Review within 4 hours
   - Determine if truly broken
   - Schedule fix

### Alert Fatigue Prevention

- Only alert on critical workflows
- Use appropriate severity levels
- Fix root causes, not symptoms
- Regular alert review

### Monitoring

Weekly review:
```bash
# Check alert history
gh run list --workflow=alert-on-failure.yml --limit 20

# Identify patterns
# Are same workflows failing repeatedly?
```

---

## Integration with Other Tools

### PagerDuty

Add PagerDuty step:

```yaml
- name: Send to PagerDuty
  if: steps.severity.outputs.level == 'CRITICAL'
  run: |
    curl -X POST https://events.pagerduty.com/v2/enqueue \
      -H 'Content-Type: application/json' \
      -d '{
        "routing_key": "${{ secrets.PAGERDUTY_KEY }}",
        "event_action": "trigger",
        "payload": {
          "summary": "Workflow failed: ${{ steps.workflow.outputs.name }}",
          "severity": "critical",
          "source": "github-actions"
        }
      }'
```

### Datadog

Add Datadog event:

```yaml
- name: Send to Datadog
  run: |
    curl -X POST "https://api.datadoghq.com/api/v1/events?api_key=${{ secrets.DD_API_KEY }}" \
      -d '{
        "title": "Workflow Failure",
        "text": "${{ steps.workflow.outputs.name }} failed",
        "alert_type": "error"
      }'
```

---

## Related Documentation

- [GitHub Actions Docs](https://docs.github.com/en/actions)
- [Slack Incoming Webhooks](https://api.slack.com/messaging/webhooks)
- [Gmail SMTP Setup](https://support.google.com/mail/answer/7126229)
