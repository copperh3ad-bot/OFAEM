# OFAEM Operator Runbook

Common operational scenarios and their resolutions. Keep this open during incidents.

## Quick reference

| Resource | Where |
|---|---|
| Repo | https://github.com/copperh3ad-bot/OFAEM |
| Project ref | `ouxnplyjzlbhmvpcvjmx` |
| Dashboard | https://supabase.com/dashboard/project/ouxnplyjzlbhmvpcvjmx |
| Functions | parse-po, render-proforma, ingest-email, plan-logistics, generate-schedule, record-quality, crisis-alert |
| Anthropic key | Stored as `ANTHROPIC_API_KEY` in Supabase secrets |
| Webhook secret | `INGEST_WEBHOOK_SECRET` (set when wiring an inbound mail provider) |

## Live observability queries

Run these in the Supabase SQL editor.

### Last 24h of pipeline activity
```sql
SELECT function_name, status, COUNT(*) AS calls,
       AVG(duration_ms)::INT AS avg_ms,
       SUM(estimated_cost_usd) AS cost_usd
FROM pipeline_metrics
WHERE created_at > now() - INTERVAL '24 hours'
GROUP BY 1, 2 ORDER BY 1, 2;
```

### Today's LLM cost by function
```sql
SELECT * FROM daily_llm_cost WHERE day = date_trunc('day', now()) ORDER BY total_cost_usd DESC NULLS LAST;
```

### Recent errors
```sql
SELECT * FROM recent_pipeline_errors LIMIT 50;
```

### Workflow state of every active PO
```sql
SELECT current_stage, COUNT(*) FROM workflow_state GROUP BY 1 ORDER BY 1;
```

### Active crises requiring action
```sql
SELECT ca.id, ca.severity, ca.crisis_type, ca.raised_at,
       ae.customer_id, ae.payload->'metadata'->>'po_id' AS po_id
FROM crisis_alerts ca
JOIN ai_extractions ae ON ae.id = ca.extraction_id
WHERE ca.status IN ('active','mitigating')
ORDER BY CASE ca.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
         ca.raised_at;
```

## Incident playbooks

### PO stuck at "extraction failed"

1. Get the failing email: `SELECT * FROM email_ingest_log WHERE classification = 'ERROR' ORDER BY received_at DESC LIMIT 10;`
2. Inspect the pipeline_metrics row: `SELECT metadata, error_code FROM pipeline_metrics WHERE error_code IS NOT NULL ORDER BY created_at DESC LIMIT 20;`
3. Common causes:
   - **`extraction failed` / no parseable JSON** — LLM returned empty or non-JSON. Often transient. Delete the ERROR row in `email_ingest_log` so the next retry isn't deduped, then resubmit.
   - **`no line items extracted`** — classifier mis-classified an empty status email as PO. Either tighten the classifier prompt or live with the 422 (the row never makes it past validation).
   - **`rate_limit_exceeded`** — sender is sending too fast. Check `rate_limit_counters` for that key. Either bump `RL_MAX` in ingest-email/index.ts or wait out the window.

To force a retry of a stuck Message-ID:
```sql
DELETE FROM email_ingest_log WHERE message_id = '<id>';
```
Then POST the same raw_email again.

### Buyer reports wrong invoice total

1. Pull the extraction:
   ```sql
   SELECT id, version_number, payload->'totals' FROM ai_extractions
   WHERE customer_id = '<BUYER>' AND payload->'metadata'->>'po_id' = '<PO>'
   ORDER BY version_number DESC;
   ```
2. If multiple versions exist, the buyer may be looking at an old version. The `is_current_version=true` row is authoritative.
3. If the current version's totals are wrong, check ml_feedback for prior corrections on this customer, then re-ingest with the buyer-corrected source. The revision flow will supersede the bad row.
4. If a proforma_invoices row was already generated with the wrong totals, mark it superseded:
   ```sql
   UPDATE proforma_invoices SET is_ready_for_invoicing = false WHERE id = '<id>';
   ```
   Then re-run `render-proforma` against the corrected extraction.

### RLS lockout — user can't see their POs

1. Check the user's role:
   ```sql
   SELECT email, role, is_active FROM user_profiles WHERE email = '<user>';
   ```
2. If role is `Viewer` or unset, they only have SELECT, no writes. Promote via Owner-only update.
3. If they get permission-denied on `ai_extraction_raw_content`, that's by design — only Owner/Manager read raw_content (PII isolation, migration 0009).

### Anthropic outage

Symptoms: every extraction returns `extraction failed`, `pipeline_metrics.error_code` shows generic failures, no model_used recorded.

1. Verify on https://status.anthropic.com
2. The `withRetry` helper retries 429/529/5xx with backoff. If retries are exhausted, the call dies cleanly.
3. There's no offline fallback — POs queue up as ERROR rows in `email_ingest_log`. After Anthropic recovers:
   ```sql
   -- Find all errored emails in the outage window
   SELECT message_id, from_address, subject FROM email_ingest_log
   WHERE classification = 'ERROR' AND received_at > '<outage_start>';
   -- DELETE them so the dedupe key clears
   DELETE FROM email_ingest_log WHERE classification = 'ERROR' AND received_at > '<outage_start>';
   ```
4. Re-send the original `raw_email` payloads (your mail provider should have them).

### Rate-limit window cleanup

The `rate_limit_counters` table grows. Run nightly:
```sql
SELECT cleanup_rate_limit_counters();
```
Set up a Supabase cron job: Dashboard → Database → Cron → New cron job, schedule `0 3 * * *`, command `SELECT cleanup_rate_limit_counters();`.

### Rolling back a deployment

Tags are deployment-stable rollback points. To revert code:
```bash
cd ~/Code/OFAEM
git checkout rollback-2026-05-13-phase3b   # or any other rollback-* tag
# Redeploy functions from the checked-out tag
for fn in parse-po render-proforma ingest-email plan-logistics generate-schedule record-quality crisis-alert; do
  supabase functions deploy "$fn"
done
```

DO NOT roll back migrations without a plan — Supabase migrations are forward-only. If you need to undo schema changes, write a new migration that reverses them.

### Force re-classification of an email

The classifier might mis-judge an edge case. To force-reprocess:
```sql
DELETE FROM email_ingest_log WHERE id = '<log_id>';
```
Then POST the same `raw_email` to `/functions/v1/ingest-email`.

## Anthropic key rotation

```bash
# 1. Generate new key in Anthropic console
# 2. Stage it as a secondary secret name
supabase secrets set ANTHROPIC_API_KEY_NEW=<new>
# 3. Update functions to read ANTHROPIC_API_KEY_NEW with fallback to ANTHROPIC_API_KEY
# 4. After verification, swap
supabase secrets set ANTHROPIC_API_KEY=<new>
supabase secrets unset ANTHROPIC_API_KEY_NEW
# 5. Revoke the old key in Anthropic console
```

## Deploying a single function in isolation

```bash
cd ~/Code/OFAEM
supabase functions deploy <function-name>
```

The Supabase CLI bundles only that function plus statically-imported shared modules. Functions are independent in production — deploying one does NOT redeploy the others.
