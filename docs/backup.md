# OFAEM Backup & Restore

What to back up, how often, and how to recover.

## What needs backing up

| Asset | Where | Frequency | Why |
|---|---|---|---|
| Postgres database | `db.ouxnplyjzlbhmvpcvjmx.supabase.co` | Daily (Supabase auto), weekly manual | Source of truth |
| Storage bucket `proforma-invoices` | Supabase Storage | Daily | Generated invoice artifacts |
| Anthropic API key | Anthropic console | Never (rotate, don't backup) | Secrets shouldn't be persisted |
| Supabase service-role key | Supabase dashboard | Never (rotate) | Same |
| Edge function source | This repo (git) | On every commit | Already covered |
| Migrations | This repo (`supabase/migrations/`) | On every commit | Already covered |

## Supabase automatic backups

Supabase Pro and above run daily PITR (point-in-time recovery). Free tier provides 7-day daily backups. Check the dashboard: Settings → Backups.

**Action:** Verify the OFAEM project has backups enabled. If on free tier and any production data is here, upgrade.

## Manual weekly logical backup

Run from a workstation with the database password set in `.env`:

```bash
PGPASSWORD=$DB_PASSWORD pg_dump \
  -h db.ouxnplyjzlbhmvpcvjmx.supabase.co \
  -U postgres \
  -d postgres \
  --schema=public \
  --no-owner --no-privileges \
  --exclude-table=rate_limit_counters \
  --exclude-table=ai_extraction_raw_content \
  -F c \
  -f "ofaem-$(date -u +%Y%m%d).backup"
```

Notes:
- `--exclude-table=rate_limit_counters` keeps the dump small; the table is regenerated automatically.
- `--exclude-table=ai_extraction_raw_content` keeps raw buyer email bodies out of the backup. If you NEED them retained for audit, drop the exclude.
- Encrypt the dump before storing off-Supabase:
  ```bash
  age -r <recipient-pubkey> ofaem-20260513.backup > ofaem-20260513.backup.age
  ```

## Storage bucket export

```bash
supabase storage download \
  --project-ref ouxnplyjzlbhmvpcvjmx \
  --recursive \
  proforma-invoices \
  ./storage-backups/$(date -u +%Y%m%d)/
```

## Restore drill (quarterly)

To verify backups actually work, run a quarterly restore drill against a fresh test project:

```bash
# 1. Create a new Supabase project (test-restore-YYYYMM)
# 2. Apply all migrations to the new project
cd ~/Code/OFAEM
supabase link --project-ref <test-project-ref>
supabase db push

# 3. Restore the most recent dump
PGPASSWORD=$TEST_DB_PASSWORD pg_restore \
  -h db.<test-project>.supabase.co \
  -U postgres \
  -d postgres \
  --no-owner --no-privileges \
  --data-only \
  ofaem-20260513.backup

# 4. Smoke test: try parse-po against a known PO
# 5. Tear down the test project
```

Document the drill outcome in a postmortem-style note in `docs/restore-drills/YYYY-MM.md`.

## Disaster recovery RTO/RPO targets

| Scenario | Recovery Time Objective | Recovery Point Objective |
|---|---|---|
| Edge function code regression | 5 min (rollback tag + redeploy) | 0 (code is in git) |
| Migration mistake corrupting data | 1 hour (PITR restore to before the bad migration) | < 1 hour (PITR granularity) |
| Full project loss | 4 hours (new project, apply migrations, restore data) | 24 hours (last daily backup) |
| Anthropic outage | Wait it out + replay queue | 0 (raw_email persists in email_ingest_log) |

## What is NOT backed up by design

- `rate_limit_counters` — ephemeral; rebuilt under load
- `pipeline_metrics` — operational telemetry; > 30 days of history is archived to cold storage if needed (not implemented yet)
- `error_log` — keep, but rotation strategy TBD
