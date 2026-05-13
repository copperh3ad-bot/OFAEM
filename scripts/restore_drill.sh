#!/usr/bin/env bash
# restore_drill.sh — execute the quarterly disaster-recovery drill against a
# fresh Supabase project. Verifies that backups + migrations actually restore
# OFAEM to a working state.
#
# Pre-reqs (one-time):
#   1. A test Supabase project (NOT prod). Set TEST_PROJECT_REF below.
#   2. The test project's database password. Set TEST_DB_PASSWORD env var.
#   3. The latest backup dump file. Pass as $1 or set BACKUP_FILE env var.
#
# Usage:
#   TEST_PROJECT_REF=<ref> TEST_DB_PASSWORD=<pw> ./scripts/restore_drill.sh ofaem-20260513.backup
#
# What it does:
#   1. Links the supabase CLI to the test project
#   2. Pushes every migration in supabase/migrations/ to the test DB
#   3. Restores data from the dump file (schema=public, data only)
#   4. Runs a smoke test: count rows in ai_extractions, run a SELECT against
#      workflow_state, and call check_rate_limit() to verify functions live
#   5. Reports pass/fail
#
# After a successful drill, log the outcome in docs/restore-drills/<date>.md.

set -euo pipefail

TEST_PROJECT_REF="${TEST_PROJECT_REF:-}"
BACKUP_FILE="${1:-${BACKUP_FILE:-}}"

if [[ -z "$TEST_PROJECT_REF" ]]; then
  echo "ERROR: set TEST_PROJECT_REF=<test-project-ref>" >&2; exit 1
fi
if [[ -z "$BACKUP_FILE" || ! -f "$BACKUP_FILE" ]]; then
  echo "ERROR: pass a valid backup file as \$1 or set BACKUP_FILE" >&2; exit 1
fi
if [[ -z "${TEST_DB_PASSWORD:-}" ]]; then
  echo "ERROR: set TEST_DB_PASSWORD=<test-project-db-password>" >&2; exit 1
fi

LOG_DIR="docs/restore-drills"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/$(date -u +%Y-%m-%d).md"

{
  echo "# Restore drill — $(date -u +%Y-%m-%d)"
  echo
  echo "- Test project: \`$TEST_PROJECT_REF\`"
  echo "- Backup file:  \`$BACKUP_FILE\`"
  echo
} > "$LOG_FILE"

echo "[1/4] Linking supabase CLI to test project $TEST_PROJECT_REF…"
supabase link --project-ref "$TEST_PROJECT_REF" >/dev/null

echo "[2/4] Applying every migration in supabase/migrations/ to the test DB…"
yes | supabase db push 2>&1 | tee -a "$LOG_FILE"

echo "[3/4] Restoring data from $BACKUP_FILE…"
DB_HOST="db.${TEST_PROJECT_REF}.supabase.co"
PGPASSWORD="$TEST_DB_PASSWORD" pg_restore \
  -h "$DB_HOST" \
  -U postgres \
  -d postgres \
  --no-owner --no-privileges \
  --data-only \
  --disable-triggers \
  "$BACKUP_FILE" 2>&1 | tee -a "$LOG_FILE"

echo "[4/4] Smoke tests…"
{
  echo
  echo "## Smoke tests"
  echo
  echo "### ai_extractions row count"
  echo 'SELECT COUNT(*) FROM ai_extractions;' | supabase db query --linked 2>&1 | tail -10
  echo
  echo "### workflow_state sanity"
  echo 'SELECT current_stage, COUNT(*) FROM workflow_state GROUP BY 1;' | supabase db query --linked 2>&1 | tail -15
  echo
  echo "### check_rate_limit RPC"
  echo "SELECT * FROM check_rate_limit('restore-drill', 5, 60);" | supabase db query --linked 2>&1 | tail -10
} | tee -a "$LOG_FILE"

echo
echo "Drill complete. Log written to: $LOG_FILE"
echo "Now re-link back to prod:  supabase link --project-ref ouxnplyjzlbhmvpcvjmx"
