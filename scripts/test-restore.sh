#!/bin/bash
# scripts/test-restore.sh
# Test D1 backup restore functionality
# Usage: ./scripts/test-restore.sh <backup-id>

set -e

BACKUP_ID=$1

if [ -z "$BACKUP_ID" ]; then
  echo "❌ Usage: $0 <backup-id>"
  echo "Example: $0 backup-abc123..."
  exit 1
fi

echo "🧪 Testing D1 Backup Restore"
echo "================================"
echo ""

# 1. List available backups
echo "📋 Step 1: Listing available backups..."
wrangler d1 backup list ai-nexus-db --remote

# 2. Verify the specified backup exists
echo ""
echo "🔍 Step 2: Verifying backup $BACKUP_ID exists..."
if wrangler d1 backup list ai-nexus-db --remote | grep -q "$BACKUP_ID"; then
  echo "✅ Backup found: $BACKUP_ID"
else
  echo "❌ Backup not found: $BACKUP_ID"
  exit 1
fi

# 3. Create temporary test database
echo ""
echo "🔧 Step 3: Creating temporary test database..."
TEST_DB_NAME="ai-nexus-test-restore-$(date +%s)"
wrangler d1 create "$TEST_DB_NAME"

echo ""
echo "⚠️  WARNING: Actual restore testing requires manual steps:"
echo "1. Copy the test DB ID from above"
echo "2. Run: wrangler d1 backup restore <test-db-id> --backup-id=$BACKUP_ID"
echo "3. Verify data: wrangler d1 execute <test-db-id> --command='SELECT COUNT(*) FROM models'"
echo "4. Cleanup: wrangler d1 delete <test-db-id>"
echo ""
echo "💡 For automated testing, use local database:"
echo "wrangler d1 execute ai-nexus-db --local --command='SELECT COUNT(*) FROM models'"

# 4. Cleanup instruction
echo ""
echo "🧹 To cleanup test database, run:"
echo "wrangler d1 delete $TEST_DB_NAME"
