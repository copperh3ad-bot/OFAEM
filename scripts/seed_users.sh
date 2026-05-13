#!/usr/bin/env bash
# Provision a baseline set of demo users (one per role) plus their
# user_profiles rows. Idempotent — re-running upserts the profile row
# without recreating the auth user.
#
# Required env:
#   SUPABASE_URL                 default https://ouxnplyjzlbhmvpcvjmx.supabase.co
#   SUPABASE_SERVICE_ROLE_KEY    service-role JWT (legacy eyJ... form)
#   SEED_USER_PASSWORD           default "OFAEMdemo!2026"
#
# Outputs the auth user UUIDs to stdout so callers can wire them
# downstream (e.g. into demo PO `reviewed_by` references).

set -euo pipefail

SUPABASE_URL="${SUPABASE_URL:-https://ouxnplyjzlbhmvpcvjmx.supabase.co}"
PASSWORD="${SEED_USER_PASSWORD:-OFAEMdemo!2026}"
SVC="${SUPABASE_SERVICE_ROLE_KEY:?set SUPABASE_SERVICE_ROLE_KEY (legacy JWT form)}"

USERS=(
  "owner@ofaem.local|Owner"
  "manager@ofaem.local|Manager"
  "merch@ofaem.local|Merchandiser"
  "qc@ofaem.local|QC Inspector"
  "viewer@ofaem.local|Viewer"
  "supplier@ofaem.local|Supplier"
)

create_user() {
  local email="$1"
  local resp
  resp=$(curl -sS -X POST "$SUPABASE_URL/auth/v1/admin/users" \
    -H "Authorization: Bearer $SVC" -H "apikey: $SVC" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"$PASSWORD\",\"email_confirm\":true}")
  # If user already exists, list users and pull id by email
  if echo "$resp" | grep -q '"error_code"\|"code"'; then
    resp=$(curl -sS "$SUPABASE_URL/auth/v1/admin/users?filter=$email" \
      -H "Authorization: Bearer $SVC" -H "apikey: $SVC")
    echo "$resp" | python3 -c "
import json, sys
d = json.load(sys.stdin)
users = d.get('users', [])
print(next((u['id'] for u in users if u['email'] == '$email'), ''))
"
    return
  fi
  echo "$resp" | python3 -c "import json, sys; print(json.load(sys.stdin).get('id', ''))"
}

upsert_profile() {
  local id="$1" email="$2" role="$3"
  cat <<SQL | supabase db query --linked >/dev/null
INSERT INTO user_profiles (id, email, full_name, role, is_active)
VALUES ('$id', '$email', '$(echo $role) Test', '$role', true)
ON CONFLICT (id) DO UPDATE
  SET email = EXCLUDED.email, role = EXCLUDED.role, is_active = true;
SQL
}

echo "Seeding $(echo "${#USERS[@]}") demo users at $SUPABASE_URL"
printf "%-32s %-16s %s\n" EMAIL ROLE USER_ID
printf "%-32s %-16s %s\n" "------" "----" "-------"
for spec in "${USERS[@]}"; do
  email="${spec%%|*}"
  role="${spec##*|}"
  id=$(create_user "$email")
  if [[ -z "$id" ]]; then
    echo "FAILED to create or fetch $email" >&2
    continue
  fi
  upsert_profile "$id" "$email" "$role"
  printf "%-32s %-16s %s\n" "$email" "$role" "$id"
done

echo
echo "Done. All demo users share password: $PASSWORD"
echo "Rotate the password before any production exposure."
