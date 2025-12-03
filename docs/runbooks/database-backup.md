# D1 Backup & Restore Runbook

## Quick Reference

**Backup Location**: Cloudflare D1 managed backups  
**Retention**: 30 days (Cloudflare default)  
**Frequency**: Weekly (Sundays 3 AM UTC)  
**Artifacts**: 90 days on GitHub

---

## Backup Status Check

### View All Backups
```bash
wrangler d1 backup list ai-nexus-db --remote
```

### View Latest Backup
```bash
wrangler d1 backup list ai-nexus-db --remote | head -5
```

### Check Backup Artifacts
Visit: https://github.com/YOUR_ORG/ai-nexus/actions/workflows/backup-database.yml

---

## Manual Backup

### Create Immediate Backup
```bash
# From GitHub Actions (recommended)
gh workflow run backup-database.yml

# Or via wrangler
wrangler d1 backup create ai-nexus-db --remote
```

---

## Restore Procedures

### Emergency Restore (Full Database)

**⚠️ CRITICAL: This will overwrite production data!**

```bash
# 1. Find backup ID
wrangler d1 backup list ai-nexus-db --remote

# 2. STOP ALL WRITES (disable workflows, pause ingestion)

# 3. Restore from backup
wrangler d1 backup restore ai-nexus-db --backup-id=<BACKUP_ID> --remote

# 4. Verify data
wrangler d1 execute ai-nexus-db --remote --command="SELECT COUNT(*) FROM models"

# 5. Resume operations
```

### Partial Restore (Specific Data)

```bash
# 1. Create temporary database
wrangler d1 create ai-nexus-temp

# 2. Restore backup to temp DB
wrangler d1 backup restore <TEMP_DB_ID> --backup-id=<BACKUP_ID>

# 3. Export specific data
wrangler d1 execute <TEMP_DB_ID> --command="SELECT * FROM models WHERE id='xxx'" --json

# 4. Import to production (manual SQL)
wrangler d1 execute ai-nexus-db --remote --command="INSERT INTO models ..."

# 5. Cleanup temp DB
wrangler d1 delete <TEMP_DB_ID>
```

---

## Testing Restore

### Test Backup Integrity

```bash
# Run test script
chmod +x scripts/test-restore.sh
./scripts/test-restore.sh <backup-id>
```

### Verify Backup Quality

```bash
# Check backup size (should be consistent)
wrangler d1 backup list ai-nexus-db --remote

# Spot check: restore to local
wrangler d1 backup restore ai-nexus-db --backup-id=<BACKUP_ID> --local
wrangler d1 execute ai-nexus-db --local --command="SELECT COUNT(*) FROM models"
```

---

## Troubleshooting

### Backup Failed

**Symptom**: GitHub Actions workflow failed

**Check**:
1. View workflow logs
2. Verify Cloudflare API token valid
3. Check D1 database still exists

**Fix**:
```bash
# Manual backup
wrangler d1 backup create ai-nexus-db --remote

# Verify
wrangler d1 backup list ai-nexus-db --remote
```

### Backup Not Found

**Symptom**: Recent backup missing

**Possible Causes**:
- Workflow didn't run (check cron schedule)
- Cloudflare retention expired (>30 days)
- API error during creation

**Recovery**:
```bash
# Create new backup immediately
gh workflow run backup-database.yml
```

### Restore Failed

**Symptom**: Restore command errors

**Common Issues**:
1. Wrong backup ID format
2. Backup expired (>30 days)
3. Insufficient permissions

**Solution**:
```bash
# Verify backup exists
wrangler d1 backup list ai-nexus-db --remote | grep <BACKUP_ID>

# Check API token permissions
wrangler whoami
```

---

## Backup Retention Strategy

### GitHub Artifacts
- **Metadata files**: 90 days
- **Contains**: Backup ID, timestamp, workflow link
- **Location**: Actions > Artifacts

### Cloudflare D1 Backups
- **Auto-retention**: 30 days
- **Cannot extend** (Cloudflare limitation)
- **Solution**: Export important backups to R2

### Long-term Backup (Future)

For critical data >30 days:

```bash
# Export to JSON
wrangler d1 execute ai-nexus-db --remote --command="SELECT * FROM models" --json > backup.json

# Upload to R2
wrangler r2 object put ai-nexus-backups/backup-$(date +%Y%m%d).json --file=backup.json
```

---

## Disaster Recovery Scenarios

### Scenario 1: Accidental Data Deletion

**Impact**: Some models accidentally deleted  
**Recovery Time**: 15 minutes

```bash
# 1. Find last good backup (usually last Sunday)
wrangler d1 backup list ai-nexus-db --remote

# 2. Restore to temp DB
wrangler d1 create ai-nexus-recovery
wrangler d1 backup restore <TEMP_ID> --backup-id=<BACKUP_ID>

# 3. Extract deleted models
wrangler d1 execute <TEMP_ID> --command="SELECT * FROM models WHERE id IN (...)" --json

# 4. Re-insert to production
# (Use prepared SQL script)

# 5. Cleanup
wrangler d1 delete <TEMP_ID>
```

### Scenario 2: Database Corruption

**Impact**: Entire database corrupted  
**Recovery Time**: 30-60 minutes

```bash
# 1. STOP ALL WRITES

# 2. Get latest backup
BACKUP_ID=$(wrangler d1 backup list ai-nexus-db --remote | head -2 | tail -1 | awk '{print $1}')

# 3. Full restore
wrangler d1 backup restore ai-nexus-db --backup-id=$BACKUP_ID --remote

# 4. Verify
wrangler d1 execute ai-nexus-db --remote --command="SELECT COUNT(*) FROM models"

# 5. Resume operations
```

### Scenario 3: Cloudflare Outage

**Impact**: Cannot access D1  
**Recovery Time**: Wait for Cloudflare

**Mitigation**:
- Have local backup copy
- Export recent data to R2 weekly
- Consider read replica strategy

---

## Monitoring & Alerts

### GitHub Actions Alerts

- **Success**: Slack notification (if configured)
- **Failure**: Slack alert + email
- **Check**: https://github.com/YOUR_ORG/ai-nexus/actions

### Manual Monitoring

```bash
# Weekly check (add to your calendar)
wrangler d1 backup list ai-nexus-db --remote | head -10
```

---

## Contact & Escalation

**Backup Failed**: Run manual backup immediately  
**Restore Needed**: Follow procedures above  
**Emergency**: Contact Cloudflare Support

**Logs Location**: `.wrangler/logs/`  
**Workflow History**: GitHub Actions > backup-database.yml
