#!/usr/bin/env bash
# One-stop bootstrap for a fresh OFAEM project.
#
# Order matters:
#   1. Apply migrations (creates every table + the shared_email_domains seed)
#   2. Seed master_articles (SKU catalog for the matcher)
#   3. Seed customer_email_map (buyer → customer_id overrides)
#   4. Provision demo users + user_profiles rows
#
# Required env:
#   SUPABASE_PROJECT_REF        e.g. ouxnplyjzlbhmvpcvjmx (used by `supabase link`)
#   SUPABASE_SERVICE_ROLE_KEY   legacy JWT form (for the auth admin API in step 4)
#
# Usage:
#   SUPABASE_PROJECT_REF=<ref> SUPABASE_SERVICE_ROLE_KEY=<key> ./scripts/seed_all.sh
#
# Idempotent: each step uses ON CONFLICT or existence checks.

set -euo pipefail

REF="${SUPABASE_PROJECT_REF:?set SUPABASE_PROJECT_REF}"

echo "▶ Step 1/4: link + db push"
supabase link --project-ref "$REF" >/dev/null
yes | supabase db push 2>&1 | tail -5

echo
echo "▶ Step 2/4: seed master_articles"
cat scripts/seed_master_articles.sql | supabase db query --linked >/dev/null
echo "  ok ($(echo "SELECT COUNT(*) FROM master_articles" | supabase db query --linked 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["rows"][0]["count"])') rows)"

echo
echo "▶ Step 3/4: seed customer_email_map"
cat scripts/seed_customer_map.sql | supabase db query --linked >/dev/null
echo "  ok ($(echo "SELECT COUNT(*) FROM customer_email_map" | supabase db query --linked 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["rows"][0]["count"])') rows)"

echo
echo "▶ Step 4/4: provision demo users"
./scripts/seed_users.sh

echo
echo "✔ Bootstrap complete."
echo "  Sign in to the web UI with any of the demo users (password OFAEMdemo!2026)."
echo "  Rotate that password before any non-local use."
