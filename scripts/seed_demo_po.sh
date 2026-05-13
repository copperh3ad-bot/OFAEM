#!/usr/bin/env bash
# Seed one fully-progressed demo PO so the UI dashboard shows every stage
# populated. Drives the live edge functions in order:
#
#   parse-po          (extracts a sample email PO)
#   plan-logistics    (Stage 2)
#   generate-schedule (Stage 3)
#   record-quality    (Stage 4 — passes with 0.5% defect)
#   render-proforma   (generates the invoice HTML)
#   sign-off flip     (Owner role flips both flags → trigger captures signer)
#
# This is best-effort: each step is idempotent enough to re-run, and any
# failure prints a clear error and exits non-zero.
#
# Required env:
#   SUPABASE_URL                 default https://ouxnplyjzlbhmvpcvjmx.supabase.co
#   SUPABASE_ANON_KEY
#   SUPABASE_SERVICE_ROLE_KEY    legacy JWT form (for stage 4+ which require role auth)
#   INGEST_WEBHOOK_SECRET        only needed if ingest-email path is used
#
# Use the service-role key for the auth header so role checks in
# plan-logistics / generate-schedule / record-quality / crisis-alert
# treat the caller as SERVICE_ROLE (universal admin).

set -euo pipefail

URL="${SUPABASE_URL:-https://ouxnplyjzlbhmvpcvjmx.supabase.co}"
ANON="${SUPABASE_ANON_KEY:?set SUPABASE_ANON_KEY}"
SVC="${SUPABASE_SERVICE_ROLE_KEY:?set SUPABASE_SERVICE_ROLE_KEY (legacy JWT form)}"

api_anon() {
  curl -sS -X POST "$URL/functions/v1/$1" \
    -H "Authorization: Bearer $ANON" -H "apikey: $ANON" \
    -H "Content-Type: application/json" -d "$2"
}
api_svc() {
  curl -sS -X POST "$URL/functions/v1/$1" \
    -H "Authorization: Bearer $SVC" \
    -H "Content-Type: application/json" -d "$2"
}
sql() {
  echo "$1" | supabase db query --linked
}

echo "▶ Stage 1: parse-po (email fixture)"
PARSE_BODY=$(cat <<'JSON'
{
  "source_type": "EMAIL",
  "customer_id": "DEMO_BUYER_INDITEX",
  "document_content": "PO #DEMO-FLOW-001\nDate: 2026-05-14\nPayment: LC 60 days\nCurrency: USD\nDelivery: CIF Hamburg\n\n1. Checkered cotton fabric 58 inches - 600 meters @ $2.60/m\n2. Cotton yarn 40s natural - 120 kg @ $7.80/kg\n3. White t-shirts adult large - 2000 pieces @ $1.85 each"
}
JSON
)
PARSE_RESP=$(api_anon parse-po "$PARSE_BODY")
EXTRACTION_ID=$(echo "$PARSE_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('extraction_id',''))")
if [[ -z "$EXTRACTION_ID" ]]; then
  echo "FAILED: $PARSE_RESP" >&2; exit 1
fi
echo "  extraction_id = $EXTRACTION_ID"

echo
echo "▶ Stage 2: plan-logistics"
PLAN_RESP=$(api_svc plan-logistics "{\"extraction_id\":\"$EXTRACTION_ID\"}")
echo "$PLAN_RESP" | python3 -c "import json,sys; r=json.load(sys.stdin); p=r['plan']; print(f\"  shipping={p['shipping_method']} transit={p['estimated_transit_days']}d cost={p['estimated_cost']} {p['cost_currency']}\")"

echo
echo "▶ Stage 3: generate-schedule"
SCHED_RESP=$(api_svc generate-schedule "{\"extraction_id\":\"$EXTRACTION_ID\"}")
echo "$SCHED_RESP" | python3 -c "import json,sys; r=json.load(sys.stdin); s=r['schedule']; print(f\"  production {s['production_start']}->{s['production_end']}, ship {s['shipping_date']}, deliver {s['delivery_date']}\")"

echo
echo "▶ Stage 4: record-quality (passing, 0.5% defect)"
QA_RESP=$(api_svc record-quality "{\"extraction_id\":\"$EXTRACTION_ID\",\"defect_rate_percentage\":0.5,\"passed\":true,\"certificate_types\":[\"OEKO-TEX\",\"GOTS\"],\"notes\":\"Demo: AQL 2.5 cleared\"}")
echo "$QA_RESP" | python3 -c "import json,sys; r=json.load(sys.stdin); print(f\"  passed={r.get('passed')} crisis={r.get('crisis_raised')}\")"

echo
echo "▶ Stage 5a: render-proforma"
RENDER_RESP=$(api_svc render-proforma "{\"extraction_id\":\"$EXTRACTION_ID\"}")
INVOICE_ID=$(echo "$RENDER_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('invoice_id',''))")
echo "  invoice_id = $INVOICE_ID"

echo
echo "▶ Stage 5b: sign off (flip both is_ready_for_invoicing flags)"
sql "UPDATE ai_extractions SET is_ready_for_invoicing = true WHERE id = '$EXTRACTION_ID';" >/dev/null
sql "UPDATE proforma_invoices SET is_ready_for_invoicing = true WHERE id = '$INVOICE_ID';" >/dev/null
echo "  signed off"

echo
echo "▶ Final workflow_state for the demo PO:"
sql "SELECT current_stage, shipping_method, schedule_is_tight, passed_certification, defect_rate_percentage, active_crisis_count FROM workflow_state WHERE extraction_id = '$EXTRACTION_ID';" \
  | python3 -c "import json,sys; r=json.load(sys.stdin); print(json.dumps(r['rows'][0] if r['rows'] else {}, indent=2))"

echo
echo "✔ Demo PO seeded: extraction_id=$EXTRACTION_ID"
